/**
 * Audio player with word-level synchronization using Web Audio API
 */

import { WordTimestamp } from '../asr/types';
import { PlaybackEvent, PlaybackEventHandler, SentenceAudio } from './types';
import { TimeStretch } from './TimeStretch';

// Latency introduced by time-stretching processing (~100ms for WSOLA algorithm)
const TIME_STRETCH_LATENCY = 0.1;

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private timeStretch: TimeStretch = new TimeStretch();
  private timeStretchEnabled: boolean = false;
  private startTime: number = 0;
  private pausedAt: number = 0;
  private isPlaying: boolean = false;
  private currentSentence: SentenceAudio | null = null;
  private animationFrameId: number | null = null;
  private eventHandlers: Set<PlaybackEventHandler> = new Set();
  private lastWordIndex: number = -1;
  private playbackRate: number = 1.0;

  constructor() {
    // AudioContext will be created on first user interaction
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);

      // Initialize time-stretching (async, will be ready for next playback)
      this.initTimeStretch();
    }

    // Resume if suspended (browser autoplay policy)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    return this.audioContext;
  }

  private async initTimeStretch(): Promise<void> {
    if (!this.audioContext || !this.gainNode) return;

    const success = await this.timeStretch.initialize(this.audioContext);
    if (success) {
      // Connect time-stretch node to gain node
      this.timeStretch.connect(this.gainNode);
      this.timeStretchEnabled = true;
      // Apply current playback rate as tempo
      this.timeStretch.setTempo(this.playbackRate);
    }
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
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2.0, rate));

    if (this.timeStretchEnabled) {
      // Use SoundTouch tempo for proper time-stretching (no pitch change)
      // Keep native playbackRate at 1.0 - let SoundTouch handle the speed
      this.timeStretch.setTempo(this.playbackRate);
    } else {
      // Fallback: use native playbackRate (will have pitch shift)
      if (this.currentSource) {
        this.currentSource.playbackRate.value = this.playbackRate;
      }
    }
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  async playSentence(sentence: SentenceAudio): Promise<void> {
    const ctx = this.ensureAudioContext();

    // Stop any current playback
    this.stopInternal();

    this.currentSentence = sentence;
    this.lastWordIndex = -1;

    // Create buffer source
    this.currentSource = ctx.createBufferSource();
    this.currentSource.buffer = sentence.audioBuffer;

    // Connect through time-stretch if available, otherwise direct to gain
    if (this.timeStretchEnabled && this.timeStretch.getNode()) {
      // Time-stretch handles speed - keep native playbackRate at 1.0
      this.currentSource.playbackRate.value = 1.0;
      this.currentSource.connect(this.timeStretch.getNode()!);
    } else {
      // Fallback: use native playbackRate (will have pitch shift)
      this.currentSource.playbackRate.value = this.playbackRate;
      this.currentSource.connect(this.gainNode!);
    }

    // Handle playback end
    this.currentSource.onended = () => {
      if (this.isPlaying) {
        this.emit({
          type: 'sentenceEnd',
          sentenceId: sentence.sentenceId
        });
        this.isPlaying = false;
        this.stopWordTracking();
      }
    };

    // Start playback
    this.startTime = ctx.currentTime - this.pausedAt;
    this.currentSource.start(0, this.pausedAt);
    this.isPlaying = true;
    this.pausedAt = 0;

    this.emit({
      type: 'sentenceStart',
      sentenceId: sentence.sentenceId
    });

    this.emit({ type: 'play' });

    // Start word tracking
    this.startWordTracking();
  }

  pause(): void {
    if (!this.isPlaying || !this.audioContext) return;

    this.pausedAt = this.audioContext.currentTime - this.startTime;
    this.stopInternal();
    this.isPlaying = false;

    this.emit({ type: 'pause' });
  }

  resume(): void {
    if (this.isPlaying || !this.currentSentence) return;

    const ctx = this.ensureAudioContext();

    this.currentSource = ctx.createBufferSource();
    this.currentSource.buffer = this.currentSentence.audioBuffer;

    // Connect through time-stretch if available, otherwise direct to gain
    if (this.timeStretchEnabled && this.timeStretch.getNode()) {
      // Time-stretch handles speed - keep native playbackRate at 1.0
      this.currentSource.playbackRate.value = 1.0;
      this.currentSource.connect(this.timeStretch.getNode()!);
    } else {
      // Fallback: use native playbackRate (will have pitch shift)
      this.currentSource.playbackRate.value = this.playbackRate;
      this.currentSource.connect(this.gainNode!);
    }

    this.currentSource.onended = () => {
      if (this.isPlaying) {
        this.emit({
          type: 'sentenceEnd',
          sentenceId: this.currentSentence!.sentenceId
        });
        this.isPlaying = false;
        this.stopWordTracking();
      }
    };

    this.startTime = ctx.currentTime - this.pausedAt;
    this.currentSource.start(0, this.pausedAt);
    this.isPlaying = true;

    this.emit({ type: 'play' });
    this.startWordTracking();
  }

  stop(): void {
    this.stopInternal();
    this.pausedAt = 0;
    this.currentSentence = null;
    this.lastWordIndex = -1;
    this.isPlaying = false;

    this.emit({ type: 'stop' });
  }

  private stopInternal(): void {
    this.stopWordTracking();

    if (this.currentSource) {
      // Clear onended handler BEFORE stopping to prevent unwanted sentenceEnd events
      // when we intentionally stop (pause, seek, skip). The handler should only fire
      // when audio naturally completes.
      this.currentSource.onended = null;
      try {
        this.currentSource.stop();
      } catch (e) {
        // Already stopped
      }
      this.currentSource.disconnect();
      this.currentSource = null;
    }
  }

  private startWordTracking(): void {
    this.stopWordTracking();

    const track = () => {
      if (!this.isPlaying || !this.audioContext || !this.currentSentence) return;

      // Calculate current playback position
      let elapsedTime = this.audioContext.currentTime - this.startTime;

      // Adjust for time-stretching:
      // - At tempo 2.0: we consume 2 seconds of audio per real second
      // - Word timestamps are based on original audio duration
      // - So multiply elapsed time by tempo to get position in original audio
      let audioPosition: number;
      if (this.timeStretchEnabled) {
        // Account for processing latency
        elapsedTime = Math.max(0, elapsedTime - TIME_STRETCH_LATENCY);
        // Scale by tempo to match original audio timestamps
        audioPosition = elapsedTime * this.timeStretch.getTempo();
      } else {
        // Fallback: using native playbackRate, time maps directly
        audioPosition = elapsedTime * this.playbackRate;
      }

      const wordIndex = this.findCurrentWordIndex(audioPosition);

      if (wordIndex !== this.lastWordIndex) {
        this.lastWordIndex = wordIndex;
        this.emit({
          type: 'wordChange',
          sentenceId: this.currentSentence.sentenceId,
          wordIndex: wordIndex >= 0 ? wordIndex : undefined,
          currentTime: audioPosition
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
    for (let i = 0; i < words.length; i++) {
      if (currentTime >= words[i].start && currentTime < words[i].end) {
        return i;
      }
    }

    // Check if we're past the last word
    if (words.length > 0 && currentTime >= words[words.length - 1].end) {
      return words.length - 1;
    }

    return -1;
  }

  getCurrentTime(): number {
    if (!this.audioContext) return 0;
    if (!this.isPlaying) return this.pausedAt;
    return this.audioContext.currentTime - this.startTime;
  }

  getDuration(): number {
    return this.currentSentence?.duration ?? 0;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  getAudioContext(): AudioContext {
    return this.ensureAudioContext();
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureAudioContext();
    return ctx.decodeAudioData(arrayBuffer);
  }

  // Convert Float32Array audio data to AudioBuffer
  createAudioBuffer(audioData: Float32Array, sampleRate: number): AudioBuffer {
    const ctx = this.ensureAudioContext();
    const buffer = ctx.createBuffer(1, audioData.length, sampleRate);
    // Create a new Float32Array backed by a standard ArrayBuffer to satisfy TypeScript
    const channelData = new Float32Array(audioData.length);
    channelData.set(audioData);
    buffer.copyToChannel(channelData, 0);
    return buffer;
  }

  dispose(): void {
    this.stop();
    this.timeStretch.dispose();
    this.timeStretchEnabled = false;
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
