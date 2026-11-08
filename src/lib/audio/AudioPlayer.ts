/**
 * Audio player with word-level synchronization using dual HTMLAudioElements
 * Uses native browser preservesPitch for pitch-correct speed changes
 * Implements ping-pong strategy for near-gapless playback
 */

import { PlaybackEvent, PlaybackEventHandler, SentenceAudio } from './types';
import { WordTimestamp } from '../asr/types';
import { StreamingAudioWorklet, isAudioWorkletSupported } from './StreamingAudioWorklet';
import { usePlaybackStore } from '@/store/playbackStore';

const MEDIA_ERROR_CODES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
};

/** Callback to get audio for a sentence offset ahead of current */
type GetSentenceAheadFn = (offset: number) => SentenceAudio | undefined;

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private isPlaying: boolean = false;
  private currentSentence: SentenceAudio | null = null;
  private animationFrameId: number | null = null;
  private eventHandlers: Set<PlaybackEventHandler> = new Set();
  private lastWordIndex: number = -1;
  private playbackRate: number = 1.0;
  private volume: number = 1.0;
  private playInProgress: boolean = false;
  // FIX #6: Async lock to prevent race condition in playSentence
  private playLock: Promise<void> = Promise.resolve();
  private playLockResolve: (() => void) | null = null;

  // Dual-player ping-pong strategy for near-gapless playback
  private playerA: HTMLAudioElement | null = null;
  private playerB: HTMLAudioElement | null = null;
  private mediaSourceA: MediaElementAudioSourceNode | null = null;
  private mediaSourceB: MediaElementAudioSourceNode | null = null;
  private activePlayer: 'A' | 'B' = 'A';
  private nextSentenceQueued: SentenceAudio | null = null;
  // Set only while startNextPlayer() synchronously emits sentenceStart for a
  // near-end hand-off, so listeners can tell a player-driven advance apart from
  // a caller-requested start (see AudioSyncService.isHandoffStart).
  private handoffSentenceId: string | null = null;
  // Bumped by stopInternal(); an in-flight playSentence/resume that sees a
  // different value was superseded and must not start audio or emit events.
  private playbackGeneration: number = 0;

  // Gapless mode state
  private gaplessMode: boolean = false;
  private getSentenceAhead: GetSentenceAheadFn | null = null;

  // Streaming mode state
  private streamingWorklet: StreamingAudioWorklet | null = null;
  private isStreamingMode: boolean = false;
  private streamingStartTime: number = 0;
  private streamingSessionId: number = 0;  // Guard against stale ended events
  private streamingSamplesConsumed: number = 0;  // Track samples for accurate word timing
  private streamingStarted: boolean = false;  // Worklet reported 'started' for the current sentence

  constructor() {
    // AudioContext will be created on first user interaction
  }

  /**
   * Check if AudioWorklet is supported (required for streaming TTS)
   */
  isAudioWorkletSupported(): boolean {
    return isAudioWorkletSupported();
  }

  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      this.gainNode.gain.value = this.volume;

      // Create the two audio players
      this.playerA = new Audio();
      this.playerA.preservesPitch = true;
      this.playerA.playbackRate = this.playbackRate;
      this.playerB = new Audio();
      this.playerB.preservesPitch = true;
      this.playerB.playbackRate = this.playbackRate;

      // Connect both to gain node (for volume control)
      this.mediaSourceA = this.audioContext.createMediaElementSource(this.playerA);
      this.mediaSourceA.connect(this.gainNode);
      this.mediaSourceB = this.audioContext.createMediaElementSource(this.playerB);
      this.mediaSourceB.connect(this.gainNode);
    }

    // Resume if suspended (browser autoplay policy)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    return this.audioContext;
  }

  addEventListener(handler: PlaybackEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: PlaybackEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error('Error in playback event handler:', e);
      }
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
    this.streamingWorklet?.setVolume(this.volume);
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2.0, rate));

    // Update both HTML audio players
    if (this.playerA) {
      this.playerA.playbackRate = this.playbackRate;
    }
    if (this.playerB) {
      this.playerB.playbackRate = this.playbackRate;
    }

    // Update streaming worklet if active
    if (this.streamingWorklet) {
      this.streamingWorklet.setPlaybackRate(this.playbackRate);
    }
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  private getActivePlayer(): HTMLAudioElement | null {
    return this.activePlayer === 'A' ? this.playerA : this.playerB;
  }

  private getInactivePlayer(): HTMLAudioElement | null {
    return this.activePlayer === 'A' ? this.playerB : this.playerA;
  }

  async playSentence(sentence: SentenceAudio): Promise<void> {
    // FIX #6: Acquire lock to prevent race condition with concurrent calls
    // This ensures only one playSentence executes at a time
    const previousLock = this.playLock;
    let resolveLock: () => void;
    this.playLock = new Promise<void>(resolve => { resolveLock = resolve; });

    // Wait for any previous play operation to complete
    await previousLock;

    if (this.playInProgress) {
      console.log('[AudioPlayer] Interrupting in-progress playback for:', sentence.sentenceId);
      this.stopInternal();
    }

    this.playInProgress = true;

    try {
      this.stopInternal();
      const generation = this.playbackGeneration;

      if (!sentence.blobUrl) {
        console.error('playSentence: No blob URL provided', sentence);
        this.emit({
          type: 'error',
          error: new Error('No audio URL available')
        });
        return;
      }

      await this.ensureAudioContext();
      // Superseded (stop / another start) while awaiting the AudioContext
      if (generation !== this.playbackGeneration) return;

      this.currentSentence = sentence;
      this.lastWordIndex = -1;

      const player = this.getActivePlayer()!;
      player.src = sentence.blobUrl;
      player.playbackRate = this.playbackRate;

      // Performance optimization #3: Removed ontimeupdate handler
      // Sentence-end detection is now consolidated in the RAF-based startWordTracking()
      // This eliminates dual timing sources that could conflict or cause jank

      // Handle playback end
      this.attachEndedHandler(player, sentence);

      player.onerror = (e) => {
        const errorCode = player.error?.code;
        const errorMessage = player.error?.message || 'Unknown error';

        console.error('Audio playback error:', {
          code: errorCode,
          codeName: errorCode ? MEDIA_ERROR_CODES[errorCode] : 'unknown',
          message: errorMessage,
          src: player.src?.substring(0, 100),
          event: e
        });

        this.emit({
          type: 'error',
          error: new Error(`Audio playback failed: ${MEDIA_ERROR_CODES[errorCode || 0] || errorMessage}`)
        });
      };

      // Capture user pause intent BEFORE awaiting play()
      // Mirrors the guard in startStreamingPlayback (lines 726-728)
      const wasPaused = usePlaybackStore.getState().session.isPaused;

      // Gain ramp to prevent click
      if (this.gainNode && this.audioContext) {
        this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      }

      await player.play();

      // Superseded while play() was pending: stopInternal already paused/cleared
      // this element. Don't flip isPlaying or emit events for a dead start.
      if (generation !== this.playbackGeneration) return;

      // Re-check pause state: user may have clicked pause DURING the await
      const currentlyPaused = usePlaybackStore.getState().session.isPaused;

      if (wasPaused || currentlyPaused) {
        // User intended to be paused — keep audio element paused, don't ramp gain
        player.pause();
        this.isPlaying = false;
        // Still emit sentenceStart so word highlighting initialises correctly,
        // but skip play/wordTracking so audio stays silent
        this.emit({
          type: 'sentenceStart',
          sentenceId: sentence.sentenceId
        });
      } else {
        this.isPlaying = true;

        // Ramp gain up
        if (this.gainNode && this.audioContext) {
          const now = this.audioContext.currentTime;
          this.gainNode.gain.linearRampToValueAtTime(this.volume, now + 0.015);
        }

        this.emit({
          type: 'sentenceStart',
          sentenceId: sentence.sentenceId
        });

        this.emit({ type: 'play' });
        this.startWordTracking();
      }

    } catch (e) {
      // play() rejects with AbortError when a stop/new start interrupts it. That
      // is a deliberate supersede, not a playback failure — emitting 'error' here
      // would set isPlaying=false and kill the playback that superseded us.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.error('Failed to start playback:', e);
      this.emit({
        type: 'error',
        error: e instanceof Error ? e : new Error('Playback failed')
      });
    } finally {
      this.playInProgress = false;
      // FIX #6: Release lock to allow next playSentence to proceed
      resolveLock!();
    }
  }

  /**
   * Prepare the next sentence in the inactive player for near-gapless transition
   */
  prepareNextSentence(sentence: SentenceAudio): void {
    if (!sentence.blobUrl) return;

    // Don't prepare if already preparing the same sentence
    if (this.nextSentenceQueued?.sentenceId === sentence.sentenceId) return;

    const inactivePlayer = this.getInactivePlayer();
    if (!inactivePlayer) return;

    inactivePlayer.src = sentence.blobUrl;
    inactivePlayer.playbackRate = this.playbackRate;
    inactivePlayer.preload = 'auto';
    inactivePlayer.load();

    this.nextSentenceQueued = sentence;
  }

  /**
   * Wire the end-of-playback handler for an element playing `sentence`.
   *
   * sentenceEnd always carries the element's OWN sentence id: after a near-end
   * hand-off this.currentSentence already points at the next sentence, so reading
   * it here would report the wrong sentence as finished.
   */
  private attachEndedHandler(element: HTMLAudioElement, sentence: SentenceAudio): void {
    element.onended = () => {
      element.onended = null;
      this.emit({
        type: 'sentenceEnd',
        sentenceId: sentence.sentenceId,
        duration: element.duration  // Actual audio file duration for cumulative tracking
      });

      if (this.getActivePlayer() !== element) {
        // Finished after a near-end hand-off: the other element is already playing
        // the next sentence, so isPlaying / word tracking belong to it — don't touch
        // them. This element is now free, so request the next look-ahead into it.
        this.emit({ type: 'scheduleMore', sentenceId: this.currentSentence?.sentenceId });
        return;
      }

      // Short sentence: the RAF near-end watcher never fired. Hand off now; the
      // finished element becomes the inactive one and is free for the look-ahead.
      if (this.nextSentenceQueued && this.startNextPlayer()) {
        this.emit({ type: 'scheduleMore', sentenceId: this.currentSentence?.sentenceId });
        return;
      }

      // No hand-off: playback of this element is over. The sentenceEnd listener
      // decides whether to advance.
      this.isPlaying = false;
      this.stopWordTracking();
      if (this.gaplessMode) {
        this.gaplessMode = false;
        this.emit({ type: 'stop' });
      }
    };
  }

  /**
   * Hand off to the queued next sentence: start the inactive element and swap.
   * Returns true if the hand-off happened.
   *
   * The finishing element keeps playing its last ~150ms; its onended (see
   * attachEndedHandler) later emits sentenceEnd for the finished sentence and
   * requests the next look-ahead. The sentenceStart emitted here is flagged via
   * handoffSentenceId so the listener adopts the new sentence instead of
   * restarting it.
   */
  private startNextPlayer(): boolean {
    const nextSentence = this.nextSentenceQueued;
    if (!nextSentence) return false;

    // PAUSE FORCE-RESUME GUARD: a near-end RAF watcher calls this to hand off to
    // the next sentence. If the user has paused (or playback is no longer active),
    // do NOT swap players, do NOT call play(), and do NOT emit sentenceStart —
    // emitting sentenceStart advances currentSentenceIndex. isPlaying in the store
    // flips false the instant the user presses pause, before the play-effect has
    // paused the elements and set session.isPaused, so check both.
    const store = usePlaybackStore.getState();
    if (store.session.isPaused || !store.isPlaying || !this.isPlaying) return false;

    this.nextSentenceQueued = null;

    // Swap active player
    this.activePlayer = this.activePlayer === 'A' ? 'B' : 'A';
    const newActive = this.getActivePlayer()!;

    // CRITICAL: Ensure playback rate is preserved when switching players
    newActive.playbackRate = this.playbackRate;

    // Update current sentence for word tracking
    this.currentSentence = nextSentence;
    this.lastWordIndex = -1;

    this.attachEndedHandler(newActive, nextSentence);

    // Start playing immediately
    const generation = this.playbackGeneration;
    newActive.play().catch(e => {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.error('Failed to start next player:', e);
      if (generation === this.playbackGeneration) {
        this.emit({ type: 'error', error: e instanceof Error ? e : new Error('Playback failed') });
      }
    });

    this.handoffSentenceId = nextSentence.sentenceId;
    try {
      this.emit({ type: 'sentenceStart', sentenceId: nextSentence.sentenceId });
    } finally {
      this.handoffSentenceId = null;
    }
    return true;
  }

  /**
   * Sentence id of an in-progress hand-off sentenceStart emission (null otherwise).
   */
  getHandoffSentenceId(): string | null {
    return this.handoffSentenceId;
  }

  pause(): void {
    // Invalidate a pending HTMLMediaElement.play() or resume() completion.
    // Otherwise its promise can resolve after pause and restart tracking.
    this.playbackGeneration++;
    // Authoritative pause: do NOT gate on this.isPlaying. During a dual-player
    // hand-off, the finishing element's stale onended can reset this.isPlaying to
    // false while the NEW active element is still audible — gating made pause a
    // no-op and left audio playing ("pause doesn't work / sentence force-resumes").
    // Pause BOTH elements so pause is always honored regardless of internal flag.
    this.playerA?.pause();
    this.playerB?.pause();
    this.isPlaying = false;
    this.stopWordTracking();

    this.emit({ type: 'pause' });
  }

  /**
   * Resume the active HTML element. Returns false when there is nothing to
   * resume (stopped, ended, or no audio loaded) so the caller can start fresh
   * playback instead of replaying stale audio.
   */
  resume(): boolean {
    if (this.isPlaying) return true;

    const player = this.getActivePlayer();
    if (!player || !player.src || !this.currentSentence || player.ended) return false;

    // playSentence leaves the gain at 0 when it started paused, so restore it.
    if (this.gainNode && this.audioContext) {
      const now = this.audioContext.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(this.volume, now + 0.015);
    }

    const generation = this.playbackGeneration;
    player.play().then(() => {
      if (generation !== this.playbackGeneration) return;  // stopped meanwhile
      this.isPlaying = true;
      this.emit({ type: 'play' });
      this.startWordTracking();
    }).catch(e => {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.error('Failed to resume playback:', e);
    });
    return true;
  }

  stop(): void {
    this.stopInternal();
    this.lastWordIndex = -1;
    this.isPlaying = false;
    this.gaplessMode = false;
    // Note: pause state is managed by playbackStore.session.isPaused

    this.emit({ type: 'stop' });
  }

  /**
   * Stop playback for sentence transition - does NOT emit 'stop' event
   * Use this when transitioning between sentences to avoid corrupting playback state.
   * The 'stop' event triggers state updates that can interfere with the next sentence starting.
   */
  stopForTransition(): void {
    this.stopInternal();
    this.lastWordIndex = -1;
    this.isPlaying = false;
    // Note: Do NOT emit 'stop' event - this is a transition, not a user stop
    // Do NOT clear gaplessMode - transitions preserve playback mode
  }

  private stopInternal(): void {
    this.playbackGeneration++;
    this.stopWordTracking();

    // Stop streaming worklet FIRST to prevent overlapping audio
    // Must happen before HTMLAudioElement cleanup
    if (this.streamingWorklet) {
      this.streamingWorklet.disconnect();
      this.streamingWorklet.reset();
    }

    // Fade out to prevent click
    if (this.gainNode && this.audioContext && this.audioContext.state === 'running') {
      this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    }

    // Stop both players and drop their sources so a later resume() can never
    // replay a previous sentence's audio (and blob URLs are released).
    for (const element of [this.playerA, this.playerB]) {
      if (!element) continue;
      element.onended = null;
      element.onerror = null;
      element.ontimeupdate = null;
      element.pause();
      if (element.hasAttribute('src')) {
        element.removeAttribute('src');
        element.load();
      }
    }

    this.currentSentence = null;
    this.nextSentenceQueued = null;
    this.handoffSentenceId = null;

    // FIX #3: Clear streaming state to prevent stale word tracking
    this.isStreamingMode = false;
    this.streamingStarted = false;
    this.streamingSamplesConsumed = 0;

    // FIX #6: Ensure playInProgress is cleared to prevent deadlocks
    this.playInProgress = false;
  }

  private startWordTracking(): void {
    this.stopWordTracking();

    const track = () => {
      // js-cache-property-access: hoist repeated this.* reads into locals for the RAF hot path
      const isPlaying = this.isPlaying;
      const sentence = this.currentSentence;
      if (!isPlaying || !sentence) {
        return;
      }

      let currentTime: number;
      let player: HTMLAudioElement | null = null;

      if (this.isStreamingMode) {
        // For streaming: compute elapsed time from samples consumed
        // The worklet reports consumed SOURCE samples, so this stays in the
        // model's content timeline even when Web Audio resamples 24 kHz → 48 kHz.
        currentTime = this.streamingSamplesConsumed / sentence.sampleRate;
      } else {
        // For non-streaming: use HTMLAudioElement currentTime
        player = this.getActivePlayer();
        if (!player) {
          return;
        }
        currentTime = player.currentTime;

        // Performance optimization #3: Consolidated sentence-end detection
        // Check if we're near the end and should trigger next player
        // js-cache-property-access: cache this.nextSentenceQueued / this.playbackRate
        const nextSentenceQueued = this.nextSentenceQueued;
        const playbackRate = this.playbackRate;
        if (nextSentenceQueued && player.duration) {
          const timeRemaining = player.duration - currentTime;
          // Trigger when ~150ms remaining (adjusted for playback rate).
          // startNextPlayer() refuses while pause is pending, so this retries on
          // later frames / after resume instead of latching.
          if (timeRemaining < 0.15 / playbackRate && this.startNextPlayer()) {
            // The new element is now active; track it from the next frame
            // (this frame's currentTime belongs to the finishing element).
            this.animationFrameId = requestAnimationFrame(track);
            return;
          }
        }
      }

      // Performance optimization #6: Find word with interpolation for smoother highlighting
      const wordIndex = this.findCurrentWordIndexWithInterpolation(currentTime);

      if (wordIndex !== this.lastWordIndex) {
        this.lastWordIndex = wordIndex;
        this.emit({
          type: 'wordChange',
          sentenceId: sentence.sentenceId,
          wordIndex: wordIndex >= 0 ? wordIndex : undefined,
          currentTime,
          timestampSource: sentence.timestampSource
        });
      }

      this.animationFrameId = requestAnimationFrame(track);
    };

    this.animationFrameId = requestAnimationFrame(track);
  }

  /**
   * Performance optimization #6: Find word index with interpolation
   * Uses ASR-confirmed timestamps as anchors for smoother highlighting
   * between estimated timestamps
   */
  private findCurrentWordIndexWithInterpolation(currentTime: number): number {
    // js-cache-property-access: cache this.currentSentence once to avoid repeated field reads
    const sentence = this.currentSentence;
    if (!sentence?.wordTimestamps) return -1;

    const words = sentence.wordTimestamps;
    if (words.length === 0) return -1;

    // If using ASR timestamps (high confidence), use standard binary search
    if (sentence.timestampSource === 'asr') {
      return this.findCurrentWordIndex(currentTime);
    }

    // For estimated timestamps, apply interpolation smoothing
    // Find bracketing words for interpolation
    if (currentTime >= words[words.length - 1].end) {
      return words.length - 1;
    }

    // Use binary search but with slight lookahead bias for estimated timestamps
    // This helps compensate for character-weighted estimation drift
    const baseIndex = this.findCurrentWordIndex(currentTime);

    // If we're in the last 20% of a word's duration, consider transitioning early
    // This compensates for typical estimation drift where words end slightly early
    if (baseIndex >= 0 && baseIndex < words.length - 1) {
      const currentWord = words[baseIndex];
      const wordProgress = (currentTime - currentWord.start) / (currentWord.end - currentWord.start);

      // Transition 10% earlier for estimated timestamps (smoother perceived sync)
      if (wordProgress > 0.9 && currentWord.confidence && currentWord.confidence < 0.85) {
        return baseIndex + 1;
      }
    }

    return baseIndex;
  }

  private stopWordTracking(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private findCurrentWordIndex(currentTime: number): number {
    // js-cache-property-access: cache this.currentSentence once
    const words = this.currentSentence?.wordTimestamps;
    if (!words) return -1;
    if (words.length === 0) return -1;

    if (currentTime >= words[words.length - 1].end) {
      return words.length - 1;
    }

    // Binary search
    let left = 0;
    let right = words.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const word = words[mid];

      if (currentTime >= word.start && currentTime < word.end) {
        return mid;
      } else if (currentTime < word.start) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    return -1;
  }

  getCurrentTime(): number {
    const player = this.getActivePlayer();
    return player?.currentTime ?? 0;
  }

  getDuration(): number {
    return this.currentSentence?.duration ?? 0;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  async getAudioContext(): Promise<AudioContext> {
    return this.ensureAudioContext();
  }

  async initAudioContext(): Promise<void> {
    await this.ensureAudioContext();
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = await this.ensureAudioContext();
    return ctx.decodeAudioData(arrayBuffer);
  }

  async createAudioBuffer(audioData: Float32Array, sampleRate: number): Promise<AudioBuffer> {
    const ctx = await this.ensureAudioContext();
    const buffer = ctx.createBuffer(1, audioData.length, sampleRate);
    const channelData = new Float32Array(audioData.length);
    channelData.set(audioData);
    buffer.copyToChannel(channelData, 0);
    return buffer;
  }

  /**
   * Update timestamps for the currently playing sentence (for ASR refinement)
   */
  updateActiveTimestamps(sentenceId: string, timestamps: WordTimestamp[]): void {
    if (this.currentSentence?.sentenceId === sentenceId) {
      this.currentSentence.wordTimestamps = timestamps;
      this.lastWordIndex = -1;
    }
  }

  // ============================================
  // GAPLESS PLAYBACK (DUAL-PLAYER PING-PONG)
  // ============================================

  /**
   * Main entry point for gapless playback using dual HTMLAudioElements
   */
  async playSentenceGapless(
    sentence: SentenceAudio,
    getSentenceAhead: GetSentenceAheadFn
  ): Promise<void> {
    if (this.playInProgress) {
      console.warn('playSentenceGapless: Already in progress, ignoring call');
      return;
    }

    this.playInProgress = true;
    this.getSentenceAhead = getSentenceAhead;
    this.gaplessMode = true;

    try {
      // Play the first sentence
      await this.playSentence(sentence);

      // Prepare the next sentence immediately
      const next = getSentenceAhead(1);
      if (next) {
        this.prepareNextSentence(next);
      }
    } finally {
      this.playInProgress = false;
    }
  }

  /**
   * Schedule more sentences for look-ahead (called from event handler)
   */
  scheduleMoreSentences(): void {
    if (!this.gaplessMode || !this.getSentenceAhead) return;

    // If we don't have a next sentence queued, prepare one
    if (!this.nextSentenceQueued) {
      const next = this.getSentenceAhead(1);
      if (next) {
        this.prepareNextSentence(next);
      }
    }
  }

  /**
   * Pause gapless playback
   */
  pauseGapless(): void {
    this.pause();
  }

  /**
   * Resume gapless playback
   */
  async resumeGapless(): Promise<void> {
    this.resume();
  }

  /**
   * Handle playback rate change during playback
   */
  setPlaybackRateGapless(rate: number): void {
    this.setPlaybackRate(rate);
  }

  /**
   * Stop gapless playback
   */
  stopGapless(): void {
    this.stop();
  }

  /**
   * Check if currently using gapless mode
   */
  isGaplessMode(): boolean {
    return this.gaplessMode;
  }

  /**
   * Get current sentence ID
   */
  getCurrentSentenceId(): string | null {
    return this.currentSentence?.sentenceId ?? null;
  }

  // ============================================
  // STREAMING TTS PLAYBACK (AUDIOWORKLET)
  // ============================================

  /**
   * Start streaming playback mode
   * Returns a worklet instance that can receive audio chunks
   * @param sentence - The sentence audio to play
   * @param explicitPlaybackRate - Optional explicit playback rate (avoids race with async React effects)
   */
  async startStreamingPlayback(sentence: SentenceAudio, explicitPlaybackRate?: number): Promise<StreamingAudioWorklet> {
    // Increment session ID BEFORE stopInternal to invalidate any pending callbacks
    // This guards against race conditions where stale 'ended' messages arrive after
    // a new sentence has started. Must happen BEFORE stop so old callbacks see old ID.
    const currentSessionId = ++this.streamingSessionId;

    // Stop any existing playback (old callbacks will now see stale session ID)
    this.stopInternal();
    const generation = this.playbackGeneration;
    await this.ensureAudioContext();
    if (generation !== this.playbackGeneration) {
      throw new DOMException('Playback superseded', 'AbortError');
    }

    // Streaming mode is in effect from HERE, not from the worklet's 'started'
    // (~500ms later). In between, pause()/resume() must route to the worklet:
    // otherwise pause hits only the HTML elements (worklet keeps playing) and
    // resume plays whatever HTML element is loaded.
    this.isStreamingMode = true;

    // Store sentence for word tracking
    this.currentSentence = sentence;
    this.lastWordIndex = -1;

    // Use explicit rate if provided (avoids race with async React effects)
    const rateToUse = explicitPlaybackRate ?? this.playbackRate;

    // Create or reuse streaming worklet
    if (!this.streamingWorklet) {
      // Do not publish a partially initialized worklet: a stop or another
      // start can occur while addModule() is pending.
      const worklet = new StreamingAudioWorklet();
      // Pass playbackRate via processorOptions for synchronous init (no race)
      await worklet.initialize(this.audioContext!, rateToUse, sentence.sampleRate);
      if (generation !== this.playbackGeneration) {
        worklet.dispose();
        throw new DOMException('Playback superseded', 'AbortError');
      }
      this.streamingWorklet = worklet;
    } else {
      // Reset with playback rate atomically to prevent chipmunk audio
      this.streamingWorklet.resetWithPlaybackRate(rateToUse, sentence.sampleRate);
    }

    // Emit sentenceStart BEFORE pause check to ensure it always fires
    // This is critical for word highlighting initialization
    this.emit({
      type: 'sentenceStart',
      sentenceId: sentence.sentenceId
    });

    // If user was paused, immediately pause the worklet
    // Audio will buffer but not play until user resumes
    if (usePlaybackStore.getState().session.isPaused && this.streamingWorklet) {
      this.streamingWorklet.pause();
    }

    // Reset samples consumed for new sentence
    this.streamingSamplesConsumed = 0;

    // Set up callbacks with session guard to ignore stale events
    this.streamingWorklet.setCallbacks({
      onStarted: () => {
        // Ignore if this callback is from a stale session
        if (currentSessionId !== this.streamingSessionId) {
          console.warn('[AudioPlayer] Ignoring stale onStarted callback');
          return;
        }

        // Check CURRENT pause state, not just initial wasPaused
        // User may have clicked pause AFTER streaming started but BEFORE buffer filled
        const currentlyPaused = usePlaybackStore.getState().session.isPaused;

        // Only set isPlaying to true if user hasn't paused
        // If user paused, the worklet is already paused - don't override
        if (!currentlyPaused) {
          this.isPlaying = true;
          this.emit({ type: 'play' });
        }

        this.streamingStarted = true;
        // Record start time for word tracking
        this.streamingStartTime = this.audioContext?.currentTime ?? 0;

        // Start word highlighting only if not paused
        // RAF loop requires isPlaying=true to emit wordChange events
        if (!currentlyPaused) {
          this.startWordTracking();
        }
      },
      onEnded: (samplesConsumed?: number) => {
        // CRITICAL: Ignore if this callback is from a stale session
        // This prevents race conditions where old 'ended' messages trigger
        // sentenceEnd for a newly started sentence
        if (currentSessionId !== this.streamingSessionId) {
          console.warn('[AudioPlayer] Ignoring stale onEnded callback');
          return;
        }
        this.stopWordTracking();
        // Calculate actual duration from samples consumed (accounts for playback rate)
        const duration = (samplesConsumed ?? this.streamingSamplesConsumed) / sentence.sampleRate;
        this.emit({
          type: 'sentenceEnd',
          sentenceId: sentence.sentenceId,
          duration
        });
        // CRITICAL: Set isPlaying AFTER sentenceEnd event
        // This allows the event handler to check isPlaying and trigger auto-advance
        this.isPlaying = false;
        this.isStreamingMode = false;
        this.streamingStarted = false;
        // DON'T emit 'stop' - let sentenceEnd handler decide whether to advance
        // This allows automatic sentence transitions like non-streaming modes
      },
      onProgress: (progress, samplesConsumed?: number) => {
        // Update samples consumed for word tracking
        if (samplesConsumed !== undefined) {
          this.streamingSamplesConsumed = samplesConsumed;
        }
      }
    });

    // NOTE: Playback rate already set via processorOptions (init) or resetWithPlaybackRate

    // Connect to output
    if (this.audioContext) {
      this.streamingWorklet.connect(this.audioContext.destination);
      this.streamingWorklet.setVolume(this.volume);
    }

    return this.streamingWorklet;
  }

  /**
   * Append an audio chunk to the streaming worklet
   */
  appendStreamingChunk(audio: Float32Array): void {
    if (!this.streamingWorklet) {
      console.warn('[AudioPlayer] No streaming worklet active');
      return;
    }
    this.streamingWorklet.appendChunk(audio);
  }

  /**
   * Mark streaming as complete (no more chunks coming)
   */
  finishStreaming(): void {
    if (!this.streamingWorklet) {
      console.warn('[AudioPlayer] No streaming worklet active');
      return;
    }
    this.streamingWorklet.markComplete();
  }

  /**
   * Pause streaming playback
   */
  pauseStreaming(): void {
    if (this.streamingWorklet) {
      this.streamingWorklet.pause();
    }
    this.isPlaying = false;
    // Note: pause state is tracked by playbackStore.session.isPaused
    this.emit({ type: 'pause' });
  }

  /**
   * Resume streaming playback. Returns false if no streaming sentence is active.
   */
  resumeStreaming(): boolean {
    if (!this.streamingWorklet || !this.isStreamingMode) return false;
    this.streamingWorklet.resume();
    this.isPlaying = true;
    // Note: pause state is cleared by playbackStore.session.isPaused
    this.emit({ type: 'play' });
    // Restart highlighting (the RAF loop exits while paused). Before 'started'
    // arrives, onStarted starts tracking itself.
    if (this.streamingStarted) {
      this.startWordTracking();
    }
    return true;
  }


  /**
   * Stop streaming playback
   */
  stopStreaming(): void {
    if (this.streamingWorklet) {
      this.streamingWorklet.disconnect();
      this.streamingWorklet.reset();
    }
    this.isStreamingMode = false;
    this.isPlaying = false;
    // Note: pause state is managed by playbackStore.session.isPaused
    this.emit({ type: 'stop' });
  }

  /**
   * Check if currently in streaming mode
   */
  isStreaming(): boolean {
    return this.isStreamingMode;
  }

  // Legacy compatibility methods
  async prepareNextAudio(nextSentence: SentenceAudio): Promise<void> {
    this.prepareNextSentence(nextSentence);
  }

  dispose(): void {
    this.stop();

    if (this.playerA) {
      this.playerA.src = '';
      this.playerA = null;
    }
    if (this.playerB) {
      this.playerB.src = '';
      this.playerB = null;
    }
    if (this.mediaSourceA) {
      try { this.mediaSourceA.disconnect(); } catch {}
      this.mediaSourceA = null;
    }
    if (this.mediaSourceB) {
      try { this.mediaSourceB.disconnect(); } catch {}
      this.mediaSourceB = null;
    }
    if (this.streamingWorklet) {
      this.streamingWorklet.dispose();
      this.streamingWorklet = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.eventHandlers.clear();
  }
}

// Singleton for app-wide use
let sharedPlayer: AudioPlayer | null = null;

export function getSharedAudioPlayer(): AudioPlayer {
  if (!sharedPlayer) {
    sharedPlayer = new AudioPlayer();
  }
  return sharedPlayer;
}

/**
 * Fully tear down the shared player and reset the singleton so the next
 * getSharedAudioPlayer() builds a fresh instance.
 *
 * IMPORTANT: Only call this on true app teardown. A plain AudioSyncService.dispose()
 * must NOT dispose the shared player — doing so nulls playerA/B, closes the
 * AudioContext, and clears event handlers on a singleton that newer/concurrent
 * services still reference, which silently breaks event forwarding (word
 * highlighting + auto-advance to the next sentence).
 */
export function disposeSharedAudioPlayer(): void {
  if (sharedPlayer) {
    sharedPlayer.dispose();
    sharedPlayer = null;
  }
}
