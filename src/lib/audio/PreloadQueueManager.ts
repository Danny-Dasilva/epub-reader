/**
 * Preload Queue Manager
 * Manages sentence audio preloading with priority, cancellation, and state tracking.
 * Integrates with the TTS Worker for non-blocking synthesis.
 *
 * Features:
 * - LRU cache eviction to bound memory usage
 * - Blob URL tracking and cleanup to prevent memory leaks
 * - Character-weighted word timing estimation
 */

import { Sentence } from '../epub/types';
import { TTSWorkerManager, TTSSynthesisResult } from '../tts/TTSWorkerManager';
import { SentenceAudio } from './types';
import { WordTimestamp } from '../asr/types';
import { SentenceAudioState } from '@/store/sentenceStateStore';
import { float32ToWav, createAudioBlobUrl } from '../tts/audioUtils';

export interface PreloadConfig {
  preloadCount: number;      // Max number of sentences to preload ahead (default: 4)
  preloadCharLimit: number;  // Target character count limit (default: 800)
  speed: number;             // Playback speed
  totalSteps: number;        // TTS denoising steps
  maxCacheSize: number;      // Max number of cached sentences (default: 20)
  onItemComplete?: (sentenceId: string, cacheSize: number) => void;  // Callback when item finishes preloading
}

export interface PreloadStateCallback {
  (sentenceId: string, state: SentenceAudioState): void;
}

interface QueuedRequest {
  sentence: Sentence;
  priority: number;          // 0 = current, 1 = next, etc.
  abortController: AbortController;
}

export class PreloadQueueManager {
  private ttsManager: TTSWorkerManager;
  private cache: Map<string, SentenceAudio> = new Map();
  private queue: QueuedRequest[] = [];
  private processing: QueuedRequest | null = null;
  private sessionController: AbortController | null = null;
  private config: PreloadConfig;
  private stateCallback: PreloadStateCallback | null = null;
  private audioContext: AudioContext | null = null;
  private sampleRate: number = 44100;

  // Blob URL tracking for memory leak prevention
  private blobUrls: Map<string, string> = new Map();

  // LRU cache tracking - most recently used at end
  private accessOrder: string[] = [];

  constructor(ttsManager: TTSWorkerManager, config: Partial<PreloadConfig> = {}) {
    this.ttsManager = ttsManager;
    this.config = {
      preloadCount: 4,
      preloadCharLimit: 800,
      speed: 1.0,
      totalSteps: 5,
      maxCacheSize: 20,
      ...config
    };
  }

  /**
   * Set the callback for state changes
   */
  onStateChange(callback: PreloadStateCallback): void {
    this.stateCallback = callback;
  }

  /**
   * Update config
   */
  setConfig(config: Partial<PreloadConfig>): void {
    const speedChanged = config.speed !== undefined && config.speed !== this.config.speed;
    this.config = { ...this.config, ...config };

    // Clear cache if speed changed (audio needs regeneration)
    if (speedChanged) {
      this.clearCache();
    }
  }

  /**
   * Set the AudioContext for creating buffers
   */
  setAudioContext(context: AudioContext): void {
    this.audioContext = context;
  }

  /**
   * Start a new preload session
   * Cancels all existing operations and starts fresh from the given index
   */
  startSession(sentences: Sentence[], startIndex: number): void {
    // Cancel existing session
    this.cancelSession();

    // Create new session controller
    this.sessionController = new AbortController();

    // Determine which sentences to preload
    const toPreload: Sentence[] = [];
    let totalChars = 0;

    for (
      let i = startIndex;
      i < sentences.length && toPreload.length < this.config.preloadCount;
      i++
    ) {
      const sentence = sentences[i];

      // Always include at least one sentence, then check char limit
      if (toPreload.length > 0 && totalChars >= this.config.preloadCharLimit) {
        break;
      }

      // Skip if already cached
      if (!this.cache.has(sentence.id)) {
        toPreload.push(sentence);
      }

      totalChars += sentence.text.length;
    }

    // Queue sentences with priorities
    this.queue = toPreload.map((sentence, index) => ({
      sentence,
      priority: index,
      abortController: new AbortController()
    }));

    // Link abort controllers to session
    this.sessionController.signal.addEventListener('abort', () => {
      this.queue.forEach(req => req.abortController.abort());
      if (this.processing) {
        this.processing.abortController.abort();
      }
    });

    // Mark all as preloading
    toPreload.forEach(sentence => {
      this.stateCallback?.(sentence.id, 'preloading');
    });

    // Start processing
    this.processQueue();
  }

  /**
   * Cancel the current session
   */
  cancelSession(): void {
    this.sessionController?.abort();
    this.sessionController = null;
    this.queue = [];
    this.processing = null;
  }

  /**
   * Process the next item in the queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    // Sort by priority and get the highest priority item
    this.queue.sort((a, b) => a.priority - b.priority);
    const request = this.queue.shift();

    if (!request) return;

    this.processing = request;

    try {
      // Check if cancelled before starting
      if (request.abortController.signal.aborted) {
        this.processing = null;
        this.processQueue();
        return;
      }

      // Synthesize audio
      const result = await this.ttsManager.synthesize(
        request.sentence.text,
        {
          speed: this.config.speed,
          totalSteps: this.config.totalSteps
        },
        request.abortController.signal
      );

      // Evict old entries if cache is full
      this.evictIfNeeded();

      // Create SentenceAudio
      const audio = await this.createSentenceAudio(request.sentence, result);

      // Cache the result and track access
      this.cache.set(request.sentence.id, audio);
      this.touchAccess(request.sentence.id);

      // Update state to ready
      this.stateCallback?.(request.sentence.id, 'ready');

      // Notify that an item completed (for continuous queue extension)
      this.config.onItemComplete?.(request.sentence.id, this.cache.size);

    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Cancelled - don't report as error
      } else {
        console.error('Preload failed for sentence:', request.sentence.id, error);
        this.stateCallback?.(request.sentence.id, 'error');
      }
    } finally {
      this.processing = null;
      // Continue processing queue
      this.processQueue();
    }
  }

  /**
   * Evict oldest entries if cache exceeds max size
   */
  private evictIfNeeded(): void {
    while (this.cache.size >= this.config.maxCacheSize && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift();
      if (oldest) {
        this.revokeBlob(oldest);
        this.cache.delete(oldest);
      }
    }
  }

  /**
   * Track access for LRU eviction - move to end (most recently used)
   */
  private touchAccess(sentenceId: string): void {
    const index = this.accessOrder.indexOf(sentenceId);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(sentenceId);
  }

  /**
   * Create and track a blob URL (for memory leak prevention)
   */
  private createAndTrackBlobUrl(sentenceId: string, wavBuffer: ArrayBuffer): string {
    // Revoke old URL if exists
    this.revokeBlob(sentenceId);

    const url = createAudioBlobUrl(wavBuffer);
    this.blobUrls.set(sentenceId, url);
    return url;
  }

  /**
   * Revoke a tracked blob URL
   */
  private revokeBlob(sentenceId: string): void {
    const url = this.blobUrls.get(sentenceId);
    if (url) {
      URL.revokeObjectURL(url);
      this.blobUrls.delete(sentenceId);
    }
  }

  /**
   * Revoke all tracked blob URLs
   */
  private revokeAllBlobs(): void {
    this.blobUrls.forEach(url => URL.revokeObjectURL(url));
    this.blobUrls.clear();
  }

  /**
   * Create a SentenceAudio object from synthesis result
   */
  private async createSentenceAudio(
    sentence: Sentence,
    result: TTSSynthesisResult
  ): Promise<SentenceAudio> {
    // Create blob URL for HTMLAudioElement playback with preservesPitch
    const wavBuffer = float32ToWav(result.wav, result.sampleRate);
    const blobUrl = this.createAndTrackBlobUrl(sentence.id, wavBuffer);

    // Create AudioBuffer (kept for potential fallback)
    const audioBuffer = await this.createAudioBuffer(result.wav, result.sampleRate);

    // Estimate word timings with character-weighted distribution
    const wordTimestamps = this.estimateWordTimings(sentence.text, result.duration);

    return {
      sentenceId: sentence.id,
      text: sentence.text,
      audioBuffer,
      blobUrl,
      wordTimestamps,
      duration: result.duration
    };
  }

  /**
   * Create an AudioBuffer from Float32Array
   */
  private async createAudioBuffer(
    audioData: Float32Array,
    sampleRate: number
  ): Promise<AudioBuffer> {
    // Ensure we have an AudioContext
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    const audioBuffer = this.audioContext.createBuffer(
      1,                    // mono
      audioData.length,
      sampleRate
    );

    audioBuffer.getChannelData(0).set(audioData);
    return audioBuffer;
  }

  /**
   * Estimate word timings using character-weighted distribution
   * Longer words get proportionally more time than shorter words
   */
  private estimateWordTimings(text: string, duration: number): WordTimestamp[] {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return [];

    // Weight by character count for more natural timing
    const totalChars = words.reduce((sum, w) => sum + w.length, 0);

    if (totalChars === 0) {
      // Fallback to even distribution
      const avgDuration = duration / words.length;
      return words.map((word, i) => ({
        text: word,
        start: i * avgDuration,
        end: (i + 1) * avgDuration,
        confidence: 0.5
      }));
    }

    let currentTime = 0;
    return words.map(word => {
      const wordDuration = (word.length / totalChars) * duration;
      const timestamp = {
        text: word,
        start: currentTime,
        end: currentTime + wordDuration,
        confidence: 0.7  // Lower confidence since estimated
      };
      currentTime += wordDuration;
      return timestamp;
    });
  }

  /**
   * Get cached audio for a sentence (updates LRU tracking)
   */
  getAudio(sentenceId: string): SentenceAudio | undefined {
    const audio = this.cache.get(sentenceId);
    if (audio) {
      this.touchAccess(sentenceId);
    }
    return audio;
  }

  /**
   * Check if audio is ready for a sentence
   */
  isReady(sentenceId: string): boolean {
    return this.cache.has(sentenceId);
  }

  /**
   * Prepare a single sentence (for immediate playback)
   * Returns cached audio or synthesizes it
   */
  async prepareSentence(
    sentence: Sentence,
    signal?: AbortSignal
  ): Promise<SentenceAudio> {
    // Check cache first (and update LRU)
    const cached = this.getAudio(sentence.id);
    if (cached) return cached;

    // Update state
    this.stateCallback?.(sentence.id, 'preloading');

    try {
      const result = await this.ttsManager.synthesize(
        sentence.text,
        {
          speed: this.config.speed,
          totalSteps: this.config.totalSteps
        },
        signal
      );

      // Evict if needed
      this.evictIfNeeded();

      const audio = await this.createSentenceAudio(sentence, result);
      this.cache.set(sentence.id, audio);
      this.touchAccess(sentence.id);
      this.stateCallback?.(sentence.id, 'ready');

      return audio;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.stateCallback?.(sentence.id, 'error');
      }
      throw error;
    }
  }

  /**
   * Add a sentence to the preload queue with high priority
   */
  prioritize(sentence: Sentence): void {
    // Don't add if already cached or in queue
    if (this.cache.has(sentence.id)) return;
    if (this.queue.some(r => r.sentence.id === sentence.id)) return;
    if (this.processing?.sentence.id === sentence.id) return;

    // Add to front of queue with priority 0
    this.queue.unshift({
      sentence,
      priority: 0,
      abortController: new AbortController()
    });

    this.stateCallback?.(sentence.id, 'preloading');
    this.processQueue();
  }

  /**
   * Extend the queue with additional sentences (for continuous preloading)
   * Unlike startSession, this doesn't cancel existing operations
   */
  extendQueue(sentences: Sentence[], fromIndex: number): void {
    if (!this.sessionController || this.sessionController.signal.aborted) {
      return; // No active session
    }

    const toAdd: Sentence[] = [];
    let totalChars = 0;

    for (
      let i = fromIndex;
      i < sentences.length && toAdd.length < this.config.preloadCount;
      i++
    ) {
      const sentence = sentences[i];

      // Skip if already cached, queued, or being processed
      if (this.cache.has(sentence.id)) continue;
      if (this.queue.some(r => r.sentence.id === sentence.id)) continue;
      if (this.processing?.sentence.id === sentence.id) continue;

      // Respect char limit (but always allow at least one)
      if (toAdd.length > 0 && totalChars >= this.config.preloadCharLimit) {
        break;
      }

      toAdd.push(sentence);
      totalChars += sentence.text.length;
    }

    if (toAdd.length === 0) return;

    // Add to queue with priorities based on current queue length
    const basePriority = this.queue.length + (this.processing ? 1 : 0);
    toAdd.forEach((sentence, index) => {
      const abortController = new AbortController();

      // Link to session abort
      this.sessionController!.signal.addEventListener('abort', () => {
        abortController.abort();
      });

      this.queue.push({
        sentence,
        priority: basePriority + index,
        abortController
      });

      this.stateCallback?.(sentence.id, 'preloading');
    });

    // Continue processing if not already
    this.processQueue();
  }

  /**
   * Check if a sentence is currently queued
   */
  isQueued(sentenceId: string): boolean {
    return this.queue.some(r => r.sentence.id === sentenceId);
  }

  /**
   * Check if a sentence is currently being processed
   */
  isProcessing(sentenceId: string): boolean {
    return this.processing?.sentence.id === sentenceId;
  }

  /**
   * Clear all cached audio and revoke blob URLs
   */
  clearCache(): void {
    this.revokeAllBlobs();
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Clear cache for sentences that match a predicate
   */
  clearCacheWhere(predicate: (sentenceId: string) => boolean): void {
    for (const [id] of this.cache) {
      if (predicate(id)) {
        this.revokeBlob(id);
        this.cache.delete(id);
        const index = this.accessOrder.indexOf(id);
        if (index > -1) {
          this.accessOrder.splice(index, 1);
        }
      }
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number; sentenceIds: string[] } {
    return {
      size: this.cache.size,
      maxSize: this.config.maxCacheSize,
      sentenceIds: Array.from(this.cache.keys())
    };
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.cancelSession();
    this.revokeAllBlobs();
    this.cache.clear();
    this.accessOrder = [];
    this.stateCallback = null;
  }
}
