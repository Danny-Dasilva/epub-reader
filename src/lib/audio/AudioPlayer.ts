/**
 * Audio player with word-level synchronization using HTMLAudioElement
 * Uses native browser preservesPitch for pitch-correct speed changes
 */

import { PlaybackEvent, PlaybackEventHandler, SentenceAudio } from './types';
import { WordTimestamp } from '../asr/types';

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private isPlaying: boolean = false;
  private currentSentence: SentenceAudio | null = null;
  private animationFrameId: number | null = null;
  private eventHandlers: Set<PlaybackEventHandler> = new Set();
  private lastWordIndex: number = -1;
  private playbackRate: number = 1.0;
  private volume: number = 1.0;
  private playInProgress: boolean = false;  // Guard against concurrent play calls

  constructor() {
    // AudioContext will be created on first user interaction
  }

  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      this.gainNode.gain.value = this.volume;
    }

    // Resume if suspended (browser autoplay policy) - MUST await!
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
    // Apply to current audio element - preservesPitch is true by default
    if (this.currentAudio) {
      this.currentAudio.playbackRate = this.playbackRate;
    }
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  async playSentence(sentence: SentenceAudio): Promise<void> {
    // Guard against concurrent play calls
    if (this.playInProgress) {
      console.warn('playSentence: Already in progress, ignoring call');
      return;
    }

    this.playInProgress = true;

    try {
      // Stop any current playback
      this.stopInternal();

      // Validate sentence audio
      if (!sentence.blobUrl) {
        console.error('playSentence: No blob URL provided', sentence);
        this.emit({
          type: 'error',
          error: new Error('No audio URL available')
        });
        return;
      }

      this.currentSentence = sentence;
      this.lastWordIndex = -1;

      // Ensure AudioContext is ready BEFORE creating media source
      const ctx = await this.ensureAudioContext();

      // Create HTMLAudioElement with blob URL
      this.currentAudio = new Audio(sentence.blobUrl);
      this.currentAudio.preservesPitch = true;  // Native browser time-stretching
      this.currentAudio.playbackRate = this.playbackRate;

      // Connect to Web Audio API for volume control
      this.mediaSource = ctx.createMediaElementSource(this.currentAudio);
      this.mediaSource.connect(this.gainNode!);

      // Handle playback end
      this.currentAudio.onended = () => {
        if (this.isPlaying) {
          this.emit({
            type: 'sentenceEnd',
            sentenceId: sentence.sentenceId
          });
          this.isPlaying = false;
          this.stopWordTracking();
        }
      };

      // Handle errors
      this.currentAudio.onerror = (e) => {
        const audio = this.currentAudio;
        const errorCode = audio?.error?.code;
        const errorMessage = audio?.error?.message || 'Unknown error';

        // MediaError codes: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
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
          src: audio?.src?.substring(0, 100),
          event: e
        });

        this.emit({
          type: 'error',
          error: new Error(`Audio playback failed: ${codeNames[errorCode || 0] || errorMessage}`)
        });
      };

      // Start playback with gain ramp to prevent click/pop at sentence start
      if (this.gainNode && this.audioContext) {
        // Set gain to 0 before playing to prevent initial spike
        this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      }

      await this.currentAudio.play();
      this.isPlaying = true;

      // Ramp gain up smoothly after playback starts (prevents click/glitch at start)
      if (this.gainNode && this.audioContext) {
        const now = this.audioContext.currentTime;
        this.gainNode.gain.linearRampToValueAtTime(this.volume, now + 0.015); // 15ms ramp
      }

      this.emit({
        type: 'sentenceStart',
        sentenceId: sentence.sentenceId
      });

      this.emit({ type: 'play' });

      // Start word tracking
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

  pause(): void {
    if (!this.isPlaying || !this.currentAudio) return;

    this.currentAudio.pause();
    this.isPlaying = false;
    this.stopWordTracking();

    this.emit({ type: 'pause' });
  }

  resume(): void {
    if (this.isPlaying || !this.currentAudio) return;

    this.currentAudio.play().then(() => {
      this.isPlaying = true;
      this.emit({ type: 'play' });
      this.startWordTracking();
    }).catch(e => {
      console.error('Failed to resume playback:', e);
    });
  }

  stop(): void {
    this.stopInternal();  // Already clears currentSentence
    this.lastWordIndex = -1;
    this.isPlaying = false;

    this.emit({ type: 'stop' });
  }

  private stopInternal(): void {
    this.stopWordTracking();

    // Set gain to 0 immediately before stopping to prevent click/pop
    if (this.gainNode && this.audioContext && this.audioContext.state === 'running') {
      this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    }

    if (this.currentAudio) {
      // Clear event handlers FIRST to remove closure references that capture sentence
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio.pause();
      this.currentAudio.src = '';  // Release blob URL reference
      this.currentAudio.load();    // Force release of internal audio resources
      this.currentAudio = null;
    }

    if (this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch {
        // Already disconnected
      }
      this.mediaSource = null;
    }

    // Clear sentence reference to allow GC of audio buffer and timestamps
    this.currentSentence = null;
  }

  private startWordTracking(): void {
    this.stopWordTracking();

    const track = () => {
      if (!this.isPlaying || !this.currentAudio || !this.currentSentence) return;

      // HTMLAudioElement.currentTime is already in original audio time
      // The browser handles time-stretching internally
      const currentTime = this.currentAudio.currentTime;
      const wordIndex = this.findCurrentWordIndex(currentTime);

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

    // Check if we're past the last word
    if (currentTime >= words[words.length - 1].end) {
      return words.length - 1;
    }

    // Binary search for O(log N) instead of O(N)
    let left = 0;
    let right = words.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const word = words[mid];

      if (currentTime >= word.start && currentTime < word.end) {
        return mid; // Found the word containing currentTime
      } else if (currentTime < word.start) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    return -1;
  }

  getCurrentTime(): number {
    if (!this.currentAudio) return 0;
    return this.currentAudio.currentTime;
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

  // Convert Float32Array audio data to AudioBuffer (kept for compatibility)
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
   * The word tracking loop will pick up the new timestamps on the next frame
   */
  updateActiveTimestamps(sentenceId: string, timestamps: WordTimestamp[]): void {
    if (this.currentSentence?.sentenceId === sentenceId) {
      this.currentSentence.wordTimestamps = timestamps;
      // Reset lastWordIndex to force re-evaluation with new timestamps
      this.lastWordIndex = -1;
    }
  }

  dispose(): void {
    this.stop();
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
