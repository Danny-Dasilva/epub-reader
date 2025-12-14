/**
 * Audio Synchronization Service
 * Orchestrates TTS generation and playback with word-level synchronization.
 * Uses Web Worker for non-blocking synthesis and supports cancellation.
 *
 * Word Timing Strategy:
 * - Initial: Character-weighted estimation for immediate playback
 * - Refinement: Parakeet ASR runs in background when 2+ sentences ahead
 * - Progressive: Highlights become more accurate as ASR catches up
 */

import { Sentence } from '../epub/types';
import { TTSWorkerManager, getSharedTTSWorkerManager } from '../tts/TTSWorkerManager';
import { PreloadQueueManager, PreloadStateCallback } from './PreloadQueueManager';
import { AudioPlayer, getSharedAudioPlayer } from './AudioPlayer';
import { SentenceAudio, PlaybackEvent, PlaybackEventHandler } from './types';
import { WordTimestamp } from '../asr/types';
import { SentenceAudioState } from '@/store/sentenceStateStore';

export interface AudioSyncConfig {
  ttsModelPath: string;
  voiceStylePath: string;
  preloadCount?: number;
  preloadCharLimit?: number;
  speed?: number;
  totalSteps?: number;
}

export type SyncProgressCallback = (
  stage: 'loading' | 'synthesizing' | 'transcribing' | 'ready',
  progress: number,
  message: string
) => void;

export class AudioSyncService {
  private ttsManager: TTSWorkerManager;
  private preloadManager: PreloadQueueManager;
  private player: AudioPlayer;
  private config: AudioSyncConfig;
  private isInitialized = false;
  private isInitializing = false;
  private eventHandlers: Set<PlaybackEventHandler> = new Set();
  private stateCallback: PreloadStateCallback | null = null;
  private backend: 'webgpu' | 'wasm' | null = null;

  constructor(config: AudioSyncConfig) {
    this.config = {
      preloadCount: 4,
      preloadCharLimit: 800,
      speed: 1.0,
      totalSteps: 5,
      ...config
    };

    this.ttsManager = getSharedTTSWorkerManager();
    this.preloadManager = new PreloadQueueManager(this.ttsManager, {
      preloadCount: this.config.preloadCount || 4,
      preloadCharLimit: this.config.preloadCharLimit || 800,
      speed: this.config.speed || 1.0,
      totalSteps: this.config.totalSteps || 5
    });
    this.player = getSharedAudioPlayer();
  }

  /**
   * Set callback for sentence state changes
   */
  onSentenceStateChange(callback: PreloadStateCallback): void {
    this.stateCallback = callback;
    this.preloadManager.onStateChange(callback);
  }

  /**
   * Initialize the service (loads TTS models in worker)
   */
  async initialize(progressCallback?: SyncProgressCallback): Promise<void> {
    if (this.isInitialized) return;
    if (this.isInitializing) {
      // Wait for existing initialization
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isInitializing = true;

    try {
      progressCallback?.('loading', 0, 'Initializing TTS engine...');

      // Initialize the TTS worker
      this.backend = await this.ttsManager.initialize(
        this.config.ttsModelPath,
        this.config.voiceStylePath,
        (modelName, current, total) => {
          const progress = (current / total) * 90;
          progressCallback?.('loading', progress, `Loading ${modelName}...`);
        }
      );

      // NOTE: AudioContext is NOT created here to avoid browser autoplay policy errors.
      // It will be lazily initialized on first playSentence() call (after user gesture).

      // Forward player events
      this.player.addEventListener((event) => {
        this.eventHandlers.forEach(handler => handler(event));
      });

      progressCallback?.('ready', 100, 'Ready');
      this.isInitialized = true;

    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Add an event listener
   */
  addEventListener(handler: PlaybackEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Prepare a sentence for playback (with optional abort signal)
   */
  async prepareSentence(sentence: Sentence, signal?: AbortSignal): Promise<SentenceAudio> {
    return this.preloadManager.prepareSentence(sentence, signal);
  }

  /**
   * Start preloading sentences from the given index
   */
  preloadSentences(sentences: Sentence[], startIndex: number): void {
    this.preloadManager.startSession(sentences, startIndex);
  }

  /**
   * Extend the preload queue with more sentences (for continuous preloading)
   */
  extendPreloadQueue(sentences: Sentence[], fromIndex: number): void {
    this.preloadManager.extendQueue(sentences, fromIndex);
  }

  /**
   * Preload entire chapter without count/char limits
   * Cache eviction (LRU) still applies to bound memory
   */
  preloadFullChapter(sentences: Sentence[], startIndex: number): void {
    this.preloadManager.preloadFullChapter(sentences, startIndex);
  }

  /**
   * Set callback for when a preload item completes (for continuous queue extension)
   */
  setOnPreloadComplete(callback: (sentenceId: string, cacheSize: number) => void): void {
    this.preloadManager.setConfig({ onItemComplete: callback });
  }

  /**
   * Play a sentence
   */
  async playSentence(sentence: Sentence, signal?: AbortSignal): Promise<void> {
    // Ensure AudioContext is set on first play (after user gesture)
    // This avoids browser autoplay policy errors
    if (!this.preloadManager.hasAudioContext()) {
      this.preloadManager.setAudioContext(await this.player.getAudioContext());
    }

    // Update state to playing
    this.stateCallback?.(sentence.id, 'playing');

    try {
      const audio = await this.prepareSentence(sentence, signal);
      await this.player.playSentence(audio);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Cancelled - restore to ready if cached
        if (this.preloadManager.isReady(sentence.id)) {
          this.stateCallback?.(sentence.id, 'ready');
        }
      }
      throw error;
    }
  }

  /**
   * Pause playback
   */
  pause(): void {
    this.player.pause();
  }

  /**
   * Resume playback
   */
  resume(): void {
    this.player.resume();
  }

  /**
   * Stop playback
   */
  stop(): void {
    this.player.stop();
  }

  /**
   * Cancel all pending operations
   */
  cancelAllOperations(): void {
    this.preloadManager.cancelSession();
    this.ttsManager.cancelAll();
    this.player.stop();
  }

  /**
   * Set playback volume
   */
  setVolume(volume: number): void {
    this.player.setVolume(volume);
  }

  /**
   * Set TTS speech rate (clears cache as audio needs regeneration)
   */
  setSpeechRate(rate: number): void {
    this.config.speed = rate;
    this.preloadManager.setConfig({ speed: rate });
    this.preloadManager.clearCache();
  }

  /**
   * Set audio playback rate (does NOT clear cache - just speeds up playback)
   */
  setAudioPlaybackRate(rate: number): void {
    this.player.setPlaybackRate(rate);
  }

  /**
   * @deprecated Use setSpeechRate instead
   */
  setSpeed(speed: number): void {
    this.setSpeechRate(speed);
  }

  /**
   * Set voice style
   */
  async setVoiceStyle(voiceStylePath: string): Promise<void> {
    this.config.voiceStylePath = voiceStylePath;
    await this.ttsManager.setVoiceStyle(voiceStylePath);
    this.preloadManager.clearCache();
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.ttsManager.ready();
  }

  /**
   * Check if currently playing
   */
  isPlaying(): boolean {
    return this.player.getIsPlaying();
  }

  /**
   * Get the backend being used
   */
  getBackend(): 'webgpu' | 'wasm' | null {
    return this.backend;
  }

  /**
   * Check if audio is cached for a sentence
   */
  isAudioReady(sentenceId: string): boolean {
    return this.preloadManager.isReady(sentenceId);
  }

  /**
   * Get cached audio for a sentence
   */
  getAudio(sentenceId: string): SentenceAudio | undefined {
    return this.preloadManager.getAudio(sentenceId);
  }

  /**
   * Mark a sentence as played
   */
  markPlayed(sentenceId: string): void {
    this.stateCallback?.(sentenceId, 'played');
  }

  /**
   * Clear all cached audio
   */
  clearCache(): void {
    this.preloadManager.clearCache();
  }

  // ============================================
  // ASR Refinement Integration
  // ============================================

  /**
   * Update the current playing position for ASR scheduling
   * Call this when playback starts or advances to a new sentence
   */
  setCurrentPlayingIndex(index: number, sentences: Sentence[]): void {
    this.preloadManager.setCurrentPlayingIndex(index, sentences);
  }

  /**
   * Set callback for when ASR completes and upgrades timestamps
   * Use this to update the UI or AudioPlayer with improved timings
   */
  onASRComplete(callback: (sentenceId: string, timestamps: WordTimestamp[]) => void): void {
    this.preloadManager.onASRComplete((sentenceId, timestamps) => {
      // Update the player if this sentence is currently playing
      this.player.updateActiveTimestamps(sentenceId, timestamps);
      // Also call the external callback
      callback(sentenceId, timestamps);
    });
  }

  /**
   * Clear the ASR queue (e.g., when seeking to a new position)
   */
  clearASRQueue(): void {
    this.preloadManager.clearASRQueue();
  }

  /**
   * Start preloading the Parakeet ASR model in background (non-blocking)
   * Call after TTS initialization to have ASR ready when needed
   */
  preloadParakeet(): void {
    this.preloadManager.preloadParakeet();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.cancelAllOperations();
    this.preloadManager.dispose();
    this.player.dispose();  // Closes AudioContext to release audio buffers
    this.eventHandlers.clear();
    this.isInitialized = false;
  }
}

// Singleton instance
let sharedService: AudioSyncService | null = null;

export function getSharedAudioSyncService(config?: AudioSyncConfig): AudioSyncService {
  if (!sharedService && config) {
    sharedService = new AudioSyncService(config);
  }
  if (!sharedService) {
    throw new Error('AudioSyncService not initialized. Provide config on first call.');
  }
  return sharedService;
}

export function initializeAudioSyncService(config: AudioSyncConfig): AudioSyncService {
  if (sharedService) {
    sharedService.dispose();
  }
  sharedService = new AudioSyncService(config);
  return sharedService;
}

export function disposeAudioSyncService(): void {
  sharedService?.dispose();
  sharedService = null;
}
