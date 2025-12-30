/**
 * Audio player with word-level synchronization using dual HTMLAudioElements
 * Uses native browser preservesPitch for pitch-correct speed changes
 * Implements ping-pong strategy for near-gapless playback
 */

import { PlaybackEvent, PlaybackEventHandler, SentenceAudio } from './types';
import { WordTimestamp } from '../asr/types';
import { StreamingAudioWorklet, isAudioWorkletSupported } from './StreamingAudioWorklet';

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

  // Dual-player ping-pong strategy for near-gapless playback
  private playerA: HTMLAudioElement | null = null;
  private playerB: HTMLAudioElement | null = null;
  private mediaSourceA: MediaElementAudioSourceNode | null = null;
  private mediaSourceB: MediaElementAudioSourceNode | null = null;
  private activePlayer: 'A' | 'B' = 'A';
  private nextSentenceQueued: SentenceAudio | null = null;
  private nextStartTriggered: boolean = false;

  // Gapless mode state
  private gaplessMode: boolean = false;
  private getSentenceAhead: GetSentenceAheadFn | null = null;

  // Streaming mode state
  private streamingWorklet: StreamingAudioWorklet | null = null;
  private isStreamingMode: boolean = false;
  private streamingStartTime: number = 0;
  private streamingSessionId: number = 0;  // Guard against stale ended events
  private streamingSamplesConsumed: number = 0;  // Track samples for accurate word timing

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
    this.eventHandlers.forEach(handler => {
      try {
        handler(event);
      } catch (e) {
        console.error('Error in playback event handler:', e);
      }
    });
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
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
    if (this.playInProgress) {
      console.log('[AudioPlayer] Interrupting in-progress playback for:', sentence.sentenceId);
      this.stopInternal();
      await Promise.resolve();
    }

    this.playInProgress = true;

    try {
      this.stopInternal();

      if (!sentence.blobUrl) {
        console.error('playSentence: No blob URL provided', sentence);
        this.emit({
          type: 'error',
          error: new Error('No audio URL available')
        });
        return;
      }

      await this.ensureAudioContext();

      this.currentSentence = sentence;
      this.lastWordIndex = -1;
      this.nextStartTriggered = false;

      const player = this.getActivePlayer()!;
      player.src = sentence.blobUrl;
      player.playbackRate = this.playbackRate;

      // Performance optimization #3: Removed ontimeupdate handler
      // Sentence-end detection is now consolidated in the RAF-based startWordTracking()
      // This eliminates dual timing sources that could conflict or cause jank

      // Handle playback end
      player.onended = () => {
        const sentenceId = this.currentSentence?.sentenceId || sentence.sentenceId;
        this.emit({
          type: 'sentenceEnd',
          sentenceId,
          duration: player.duration  // Actual audio file duration for cumulative tracking
        });

        // If next wasn't triggered by timeupdate (short sentences), handle here
        if (!this.nextStartTriggered && this.nextSentenceQueued) {
          this.startNextPlayer();
        } else if (!this.nextSentenceQueued) {
          // No more sentences queued - end of playback
          this.isPlaying = false;
          this.gaplessMode = false;
          this.stopWordTracking();
          this.emit({ type: 'stop' });
        }
      };

      player.onerror = (e) => {
        const errorCode = player.error?.code;
        const errorMessage = player.error?.message || 'Unknown error';
        const codeNames: Record<number, string> = {
          1: 'MEDIA_ERR_ABORTED',
          2: 'MEDIA_ERR_NETWORK',
          3: 'MEDIA_ERR_DECODE',
          4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
        };

        console.error('Audio playback error:', {
          code: errorCode,
          codeName: errorCode ? codeNames[errorCode] : 'unknown',
          message: errorMessage,
          src: player.src?.substring(0, 100),
          event: e
        });

        this.emit({
          type: 'error',
          error: new Error(`Audio playback failed: ${codeNames[errorCode || 0] || errorMessage}`)
        });
      };

      // Gain ramp to prevent click
      if (this.gainNode && this.audioContext) {
        this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      }

      await player.play();
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

    } catch (e) {
      console.error('Failed to start playback:', e);
      this.emit({
        type: 'error',
        error: e instanceof Error ? e : new Error('Playback failed')
      });
    } finally {
      this.playInProgress = false;
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
    this.nextStartTriggered = false;
  }

  /**
   * Start the next player and swap active/inactive
   */
  private startNextPlayer(): void {
    if (!this.nextSentenceQueued) return;

    const nextSentence = this.nextSentenceQueued;
    this.nextSentenceQueued = null;

    // Swap active player
    this.activePlayer = this.activePlayer === 'A' ? 'B' : 'A';
    const newActive = this.getActivePlayer()!;

    // CRITICAL: Ensure playback rate is preserved when switching players
    newActive.playbackRate = this.playbackRate;

    // Update current sentence for word tracking
    this.currentSentence = nextSentence;
    this.lastWordIndex = -1;
    this.nextStartTriggered = false;

    // Performance optimization #3: Removed ontimeupdate handler
    // Sentence-end detection is consolidated in startWordTracking() RAF loop

    newActive.onended = () => {
      this.emit({
        type: 'sentenceEnd',
        sentenceId: nextSentence.sentenceId,
        duration: newActive.duration  // Actual audio file duration for cumulative tracking
      });

      if (!this.nextStartTriggered && this.nextSentenceQueued) {
        this.startNextPlayer();
      } else if (!this.nextSentenceQueued) {
        this.isPlaying = false;
        this.gaplessMode = false;
        this.stopWordTracking();
        this.emit({ type: 'stop' });
      }
    };

    // Start playing immediately
    newActive.play().catch(e => {
      console.error('Failed to start next player:', e);
    });

    this.emit({ type: 'sentenceStart', sentenceId: nextSentence.sentenceId });

    // Request more look-ahead scheduling
    this.emit({ type: 'scheduleMore', sentenceId: nextSentence.sentenceId });
  }

  pause(): void {
    if (!this.isPlaying) return;

    const player = this.getActivePlayer();
    if (player) {
      player.pause();
    }
    this.isPlaying = false;
    this.stopWordTracking();

    this.emit({ type: 'pause' });
  }

  resume(): void {
    if (this.isPlaying) return;

    const player = this.getActivePlayer();
    if (player && player.src) {
      player.play().then(() => {
        this.isPlaying = true;
        this.emit({ type: 'play' });
        this.startWordTracking();
      }).catch(e => {
        console.error('Failed to resume playback:', e);
      });
    }
  }

  stop(): void {
    this.stopInternal();
    this.lastWordIndex = -1;
    this.isPlaying = false;
    this.gaplessMode = false;

    this.emit({ type: 'stop' });
  }

  private stopInternal(): void {
    this.stopWordTracking();

    // Fade out to prevent click
    if (this.gainNode && this.audioContext && this.audioContext.state === 'running') {
      this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    }

    // Stop both players
    if (this.playerA) {
      this.playerA.onended = null;
      this.playerA.onerror = null;
      this.playerA.ontimeupdate = null;
      this.playerA.pause();
    }
    if (this.playerB) {
      this.playerB.onended = null;
      this.playerB.onerror = null;
      this.playerB.ontimeupdate = null;
      this.playerB.pause();
    }

    this.currentSentence = null;
    this.nextSentenceQueued = null;
    this.nextStartTriggered = false;
  }

  private startWordTracking(): void {
    this.stopWordTracking();

    const track = () => {
      if (!this.isPlaying || !this.currentSentence) return;

      let currentTime: number;
      let player: HTMLAudioElement | null = null;

      if (this.isStreamingMode) {
        // For streaming: compute elapsed time from samples consumed
        // This properly accounts for playback rate changes
        const sampleRate = this.audioContext?.sampleRate ?? 44100;
        currentTime = this.streamingSamplesConsumed / sampleRate;
      } else {
        // For non-streaming: use HTMLAudioElement currentTime
        player = this.getActivePlayer();
        if (!player) return;
        currentTime = player.currentTime;

        // Performance optimization #3: Consolidated sentence-end detection
        // Check if we're near the end and should trigger next player
        if (!this.nextStartTriggered && this.nextSentenceQueued && player.duration) {
          const timeRemaining = player.duration - currentTime;
          // Trigger when ~150ms remaining (adjusted for playback rate)
          if (timeRemaining < 0.15 / this.playbackRate) {
            this.nextStartTriggered = true;
            this.startNextPlayer();
          }
        }
      }

      // Performance optimization #6: Find word with interpolation for smoother highlighting
      const wordIndex = this.findCurrentWordIndexWithInterpolation(currentTime);

      if (wordIndex !== this.lastWordIndex) {
        this.lastWordIndex = wordIndex;
        this.emit({
          type: 'wordChange',
          sentenceId: this.currentSentence.sentenceId,
          wordIndex: wordIndex >= 0 ? wordIndex : undefined,
          currentTime,
          timestampSource: this.currentSentence.timestampSource
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
    if (!this.currentSentence?.wordTimestamps) return -1;

    const words = this.currentSentence.wordTimestamps;
    if (words.length === 0) return -1;

    // If using ASR timestamps (high confidence), use standard binary search
    if (this.currentSentence.timestampSource === 'asr') {
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
    if (!this.currentSentence?.wordTimestamps) return -1;

    const words = this.currentSentence.wordTimestamps;
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
   */
  async startStreamingPlayback(sentence: SentenceAudio): Promise<StreamingAudioWorklet> {
    await this.ensureAudioContext();

    // Stop any existing playback
    this.stopInternal();

    // Increment session ID to invalidate any pending callbacks from previous session
    // This guards against race conditions where stale 'ended' messages arrive after
    // a new sentence has started
    this.streamingSessionId++;
    const currentSessionId = this.streamingSessionId;

    // Store sentence for word tracking
    this.currentSentence = sentence;
    this.lastWordIndex = -1;

    // Create or reuse streaming worklet
    if (!this.streamingWorklet) {
      this.streamingWorklet = new StreamingAudioWorklet();
      await this.streamingWorklet.initialize(this.audioContext!);
    } else {
      // Reset existing worklet
      this.streamingWorklet.reset();
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
        this.isPlaying = true;
        this.isStreamingMode = true;
        // Record start time for word tracking
        this.streamingStartTime = this.audioContext?.currentTime ?? 0;
        this.emit({
          type: 'sentenceStart',
          sentenceId: sentence.sentenceId
        });
        this.emit({ type: 'play' });
        // Start word highlighting
        this.startWordTracking();
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
        this.isPlaying = false;
        this.isStreamingMode = false;
        // Calculate actual duration from samples consumed (accounts for playback rate)
        const sampleRate = this.audioContext?.sampleRate ?? 44100;
        const duration = (samplesConsumed ?? this.streamingSamplesConsumed) / sampleRate;
        this.emit({
          type: 'sentenceEnd',
          sentenceId: sentence.sentenceId,
          duration
        });
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

    // Apply current playback rate to streaming worklet
    this.streamingWorklet.setPlaybackRate(this.playbackRate);

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
    this.emit({ type: 'pause' });
  }

  /**
   * Resume streaming playback
   */
  resumeStreaming(): void {
    if (this.streamingWorklet) {
      this.streamingWorklet.resume();
    }
    this.isPlaying = true;
    this.emit({ type: 'play' });
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
