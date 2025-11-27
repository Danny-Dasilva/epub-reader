/**
 * Audio player with word-level synchronization using HTMLAudioElement
 * Uses native browser preservesPitch for pitch-correct speed changes
 */

import { PlaybackEvent, PlaybackEventHandler, SentenceAudio } from './types';

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

  constructor() {
    // AudioContext will be created on first user interaction
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      this.gainNode.gain.value = this.volume;
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
    // Stop any current playback
    this.stopInternal();

    this.currentSentence = sentence;
    this.lastWordIndex = -1;

    // Create HTMLAudioElement with blob URL
    this.currentAudio = new Audio(sentence.blobUrl);
    this.currentAudio.preservesPitch = true;  // Native browser time-stretching
    this.currentAudio.playbackRate = this.playbackRate;

    // Connect to Web Audio API for volume control
    const ctx = this.ensureAudioContext();
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
    this.currentAudio.onerror = () => {
      console.error('Audio playback error');
      this.emit({
        type: 'error',
        error: new Error('Audio playback failed')
      });
    };

    // Start playback
    try {
      await this.currentAudio.play();
      this.isPlaying = true;

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
    this.stopInternal();
    this.currentSentence = null;
    this.lastWordIndex = -1;
    this.isPlaying = false;

    this.emit({ type: 'stop' });
  }

  private stopInternal(): void {
    this.stopWordTracking();

    if (this.currentAudio) {
      // Clear event handlers
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio.pause();
      this.currentAudio.src = '';  // Release blob URL reference
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
    if (!this.currentAudio) return 0;
    return this.currentAudio.currentTime;
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

  // Convert Float32Array audio data to AudioBuffer (kept for compatibility)
  createAudioBuffer(audioData: Float32Array, sampleRate: number): AudioBuffer {
    const ctx = this.ensureAudioContext();
    const buffer = ctx.createBuffer(1, audioData.length, sampleRate);
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
