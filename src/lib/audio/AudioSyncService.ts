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
  enableLazyVoiceLoading?: boolean;
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
        },
        this.config.enableLazyVoiceLoading
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
   * Play a sentence using streaming TTS (if enabled and not cached)
   * Falls back to regular playback if streaming is disabled or audio is cached
   */
  async playSentenceStreaming(sentence: Sentence, enableStreaming: boolean, signal?: AbortSignal): Promise<void> {
    // Ensure AudioContext is set on first play
    if (!this.preloadManager.hasAudioContext()) {
      this.preloadManager.setAudioContext(await this.player.getAudioContext());
    }

    // Check if audio is already cached - use non-streaming path for instant playback
    const cachedAudio = this.preloadManager.getAudio(sentence.id);
    if (cachedAudio) {
      // Audio is cached, use regular (non-streaming) playback for instant start
      this.stateCallback?.(sentence.id, 'playing');
      await this.player.playSentence(cachedAudio);
      this.prepareNextSentenceAudio();
      return;
    }

    // Audio not cached - use streaming if enabled and supported
    if (!enableStreaming) {
      // Streaming disabled, fall back to regular synthesis + playback
      await this.playSentence(sentence, signal);
      return;
    }

    // Check if AudioWorklet is supported (required for streaming)
    const audioWorkletSupported = this.player.isAudioWorkletSupported();
    if (!audioWorkletSupported) {
      console.warn('[AudioSyncService] AudioWorklet not supported, falling back to regular playback');
      await this.playSentence(sentence, signal);
      return;
    }

    // Start streaming playback
    this.stateCallback?.(sentence.id, 'playing');

    try {
      // Generate estimated word timestamps for word highlighting
      const wordTimestamps = this.generateEstimatedTimestamps(sentence.text, this.config.speed || 1.0);

      // Create SentenceAudio object for tracking (some fields not used in streaming mode)
      const sentenceAudio: SentenceAudio = {
        sentenceId: sentence.id,
        text: sentence.text,
        rawPcm: new Float32Array(0),  // Not used for streaming
        sampleRate: 44100,  // Not used for streaming
        wordTimestamps,
        duration: 0,  // Will be calculated when streaming ends
        timestampSource: 'estimated',
      };

      // Initialize streaming worklet with sentence data for word tracking
      const worklet = await this.player.startStreamingPlayback(sentenceAudio);

      // Start streaming synthesis
      await this.ttsManager.synthesizeStreaming(
        sentence.text,
        {
          speed: this.config.speed || 1.0,
          totalSteps: this.config.totalSteps || 5,
          chunkDurationMs: 500,  // 500ms chunks for ~500ms time-to-first-audio
          preprocessedText: sentence.preprocessedText,
          onChunk: (audio: Float32Array, chunkIndex: number, isLast: boolean) => {
            // Append chunk to worklet for immediate playback
            this.player.appendStreamingChunk(audio);

            // Mark complete when last chunk received
            if (isLast) {
              this.player.finishStreaming();
            }
          }
        },
        signal
      );

    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Cancelled - restore to ready if cached
        if (this.preloadManager.isReady(sentence.id)) {
          this.stateCallback?.(sentence.id, 'ready');
        }
      } else {
        // Streaming failed, try falling back to regular synthesis
        console.warn('[AudioSyncService] Streaming failed, falling back to regular synthesis:', error);
        await this.playSentence(sentence, signal);
      }
      throw error;
    }
  }

  /**
   * Play a sentence (legacy method - uses HTMLAudioElement)
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

      // Optimization #1: Pre-warm the next sentence's audio element in background
      // This eliminates ~5-15ms setup delay at sentence boundaries
      this.prepareNextSentenceAudio();
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
   * Optimization #1: Pre-warm the next sentence's audio element
   * Called after starting playback of current sentence
   */
  private prepareNextSentenceAudio(): void {
    // Get the next sentence audio from preload manager's tracking
    const nextAudio = this.preloadManager.getNextSentenceAudio();
    if (nextAudio) {
      // Pre-warm the audio element in the player (async, non-blocking)
      this.player.prepareNextAudio(nextAudio).catch(err => {
        console.warn('[AudioSyncService] Failed to pre-warm next audio:', err);
      });
    }
  }

  // ============================================
  // GAPLESS PLAYBACK METHODS
  // ============================================

  // Store sentences array for gapless look-ahead
  private currentSentences: Sentence[] = [];
  private currentSentenceIndex: number = 0;

  /**
   * Play a sentence using gapless playback
   * Pre-schedules next sentences for sample-accurate transitions
   */
  async playSentenceGapless(
    sentence: Sentence,
    sentences: Sentence[],
    currentIndex: number,
    signal?: AbortSignal
  ): Promise<void> {
    // Ensure AudioContext is set
    if (!this.preloadManager.hasAudioContext()) {
      this.preloadManager.setAudioContext(await this.player.getAudioContext());
    }

    // Store for look-ahead callback
    this.currentSentences = sentences;
    this.currentSentenceIndex = currentIndex;

    // Update state to playing
    this.stateCallback?.(sentence.id, 'playing');

    try {
      // Prepare current sentence
      const audio = await this.prepareSentence(sentence, signal);

      // Create look-ahead callback that uses the stored sentences
      const getSentenceAhead = (offset: number): SentenceAudio | undefined => {
        const targetIndex = this.currentSentenceIndex + offset;
        if (targetIndex < 0 || targetIndex >= this.currentSentences.length) {
          return undefined;
        }
        const targetSentence = this.currentSentences[targetIndex];
        return this.preloadManager.getAudio(targetSentence.id);
      };

      // Start gapless playback
      await this.player.playSentenceGapless(audio, getSentenceAhead);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (this.preloadManager.isReady(sentence.id)) {
          this.stateCallback?.(sentence.id, 'ready');
        }
      }
      throw error;
    }
  }

  /**
   * Get audio for a sentence at offset from current position
   * Used by player for look-ahead scheduling
   */
  getSentenceAhead(offset: number): SentenceAudio | undefined {
    const targetIndex = this.currentSentenceIndex + offset;
    if (targetIndex < 0 || targetIndex >= this.currentSentences.length) {
      return undefined;
    }
    const targetSentence = this.currentSentences[targetIndex];
    return this.preloadManager.getAudio(targetSentence.id);
  }

  /**
   * Update current position for gapless playback (called on sentence transitions)
   */
  updateGaplessPosition(sentenceId: string): void {
    const index = this.currentSentences.findIndex(s => s.id === sentenceId);
    if (index !== -1) {
      this.currentSentenceIndex = index;
    }
  }

  /**
   * Schedule more look-ahead sentences in gapless mode
   */
  scheduleMoreSentences(): void {
    this.player.scheduleMoreSentences();
  }

  /**
   * Check if player is in gapless mode
   */
  isGaplessMode(): boolean {
    return this.player.isGaplessMode();
  }

  /**
   * Pause playback (handles streaming, gapless, and legacy modes)
   */
  pause(): void {
    if (this.player.isStreaming()) {
      this.player.pauseStreaming();
    } else if (this.player.isGaplessMode()) {
      this.player.pauseGapless();
    } else {
      this.player.pause();
    }
  }

  /**
   * Resume playback (handles streaming, gapless, and legacy modes)
   */
  resume(): void {
    if (this.player.isStreaming()) {
      this.player.resumeStreaming();
    } else if (this.player.isGaplessMode()) {
      this.player.resumeGapless();
    } else {
      this.player.resume();
    }
  }

  /**
   * Stop playback (handles both legacy and gapless modes)
   */
  stop(): void {
    if (this.player.isGaplessMode()) {
      this.player.stopGapless();
    } else {
      this.player.stop();
    }
  }

  /**
   * Cancel all pending operations
   */
  cancelAllOperations(): void {
    this.preloadManager.cancelSession();
    this.ttsManager.cancelAll();
    if (this.player.isGaplessMode()) {
      this.player.stopGapless();
    } else {
      this.player.stop();
    }
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
    if (this.player.isGaplessMode()) {
      this.player.setPlaybackRateGapless(rate);
    } else {
      this.player.setPlaybackRate(rate);
    }
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
    // Stop player FIRST to release blob URL references before cache is cleared
    this.player.stop();

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
   * Initialize the AudioContext early (in response to user gesture)
   * This warms up the audio system before first playback
   */
  async initAudioContext(): Promise<void> {
    await this.player.initAudioContext();
  }

  /**
   * Start preloading the Parakeet ASR model in background (non-blocking)
   * Call after TTS initialization to have ASR ready when needed
   */
  preloadParakeet(): void {
    this.preloadManager.preloadParakeet();
  }

  /**
   * Enable or disable ASR word timestamp refinement
   * When disabled, clears any pending ASR work and prevents model loading
   */
  setEnableASR(enabled: boolean): void {
    this.preloadManager.setConfig({ enableASR: enabled });

    // Clear pending ASR queue when disabling
    if (!enabled) {
      this.preloadManager.clearASRQueue();
    }
  }

  /**
   * Generate estimated word timestamps from text for streaming mode
   * Uses character-weighted estimation similar to PreloadQueueManager
   */
  private generateEstimatedTimestamps(text: string, speed: number): WordTimestamp[] {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return [];

    const totalChars = words.reduce((sum, w) => sum + w.length, 0);
    // Estimate ~15 chars/sec at 1.0 speed, adjusted for actual speed
    const estimatedDuration = (totalChars / 15) / speed;

    let currentTime = 0;
    return words.map(word => {
      const wordDuration = (word.length / totalChars) * estimatedDuration;
      const timestamp: WordTimestamp = {
        text: word,
        start: currentTime,
        end: currentTime + wordDuration,
      };
      currentTime += wordDuration;
      return timestamp;
    });
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
