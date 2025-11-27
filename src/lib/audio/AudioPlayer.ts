/**
 * Audio player with word-level synchronization using Web Audio API
 */

import { WordTimestamp } from '../asr/types';
import { PlaybackEvent, PlaybackEventHandler, SentenceAudio } from './types';

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private startTime: number = 0;
  private pausedAt: number = 0;
  private isPlaying: boolean = false;
  private currentSentence: SentenceAudio | null = null;
  private animationFrameId: number | null = null;
  private eventHandlers: Set<PlaybackEventHandler> = new Set();
  private lastWordIndex: number = -1;

  constructor() {
    // AudioContext will be created on first user interaction
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
    }

    // Resume if suspended (browser autoplay policy)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
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
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
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
    this.currentSource.connect(this.gainNode!);

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
    this.currentSource.connect(this.gainNode!);

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

      const currentTime = this.audioContext.currentTime - this.startTime;
      const wordIndex = this.findCurrentWordIndex(currentTime);

      if (wordIndex !== this.lastWordIndex) {
        this.lastWordIndex = wordIndex;
        this.emit({
          type: 'wordChange',
          sentenceId: this.currentSentence.sentenceId,
          wordIndex: wordIndex >= 0 ? wordIndex : undefined,
          currentTime
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
