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
import { ParakeetASR, getSharedParakeetASR } from '../asr/parakeet';
import { SentenceAudioState } from '@/store/sentenceStateStore';
import { float32ToWav, createAudioBlobUrl, resampleAudio } from '../tts/audioUtils';
import { MinHeap } from '../utils/MinHeap';
import { getAudioCacheService, AudioCacheParams } from './AudioCacheService';

export interface PreloadConfig {
  preloadCount: number;      // Max number of sentences to preload ahead (default: 4)
  preloadCharLimit: number;  // Target character count limit (default: 800)
  speed: number;             // Playback speed
  totalSteps: number;        // TTS denoising steps for preloaded sentences (default: 5)
  urgentSteps: number;       // Steps for urgent/current sentences (default: 3)
  maxCacheSize: number;      // Max number of cached sentences (default: 20)
  maxConcurrentTTS: number;  // Max concurrent TTS synthesis operations (default: 2)
  batchCharLimit: number;    // Max combined chars for batching short sentences (default: 600)
  singleSentenceLimit: number; // Max chars for a sentence to be batched (default: 300)
  enableASR: boolean;        // Enable ASR word timestamp refinement (default: false)
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

interface BatchedRequest {
  sentences: Sentence[];           // Original sentences in batch
  combinedText: string;            // Concatenated text
  charBoundaries: number[];        // Character positions where each sentence ends
  abortController: AbortController;
  priority: number;
}

export class PreloadQueueManager {
  private ttsManager: TTSWorkerManager;
  private cache: Map<string, SentenceAudio> = new Map();
  // Optimization #2: Use min-heap for O(log n) insertion instead of O(n log n) sort
  private queue = new MinHeap<QueuedRequest>((a, b) => a.priority - b.priority);
  // Performance optimization #4: O(1) queue membership check
  private queuedIds = new Set<string>();
  private activeRequests: Map<string, QueuedRequest> = new Map();  // Track concurrent TTS operations
  private sessionController: AbortController | null = null;
  private config: PreloadConfig;
  private stateCallback: PreloadStateCallback | null = null;
  private audioContext: AudioContext | null = null;
  private sampleRate: number = 44100;
  private playbackRate: number = 1.0;

  // Blob URL tracking for memory leak prevention
  private blobUrls: Map<string, string> = new Map();

  // LRU cache tracking - Map of sentenceId -> access timestamp for O(1) operations
  // Fix #4: Using Map instead of array for O(1) access tracking vs O(n²)
  private accessOrder: Map<string, number> = new Map();

  // ASR refinement for accurate word timestamps
  // Performance optimization #8: Use Set for O(1) membership checks, array for FIFO order
  private asrQueue: string[] = [];              // Sentence IDs pending ASR (FIFO order)
  private asrQueueSet = new Set<string>();      // O(1) membership check
  private asrProcessing: string | null = null;  // Currently processing ASR
  private currentPlayingIndex: number = -1;     // Track playback position
  private currentSentences: Sentence[] = [];    // Current sentence list
  private parakeet: ParakeetASR | null = null;  // Lazy-loaded ASR instance
  private parakeetInitPromise: Promise<ParakeetASR> | null = null;  // Track initialization
  private asrCompleteCallback: ((sentenceId: string, timestamps: WordTimestamp[]) => void) | null = null;

  // Audio caching with Service Worker
  private audioCache = getAudioCacheService();
  private audioCacheEnabled: boolean = true;
  private currentBookId: string = '';
  private currentVoice: string = '';
  private currentSpeechRate: number = 1.0;

  constructor(ttsManager: TTSWorkerManager, config: Partial<PreloadConfig> = {}) {
    this.ttsManager = ttsManager;

    // Adaptive cache size based on device memory
    // navigator.deviceMemory returns RAM in GB (4, 8, etc.) - undefined on some browsers
    // Use larger cache to support full chapter preloading without evicting nearby sentences
    const deviceMemory = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
    const adaptiveCacheSize = deviceMemory && deviceMemory < 4 ? 50 : 100;

    this.config = {
      preloadCount: 4,
      preloadCharLimit: 800,
      speed: 1.0,
      totalSteps: 5,
      urgentSteps: 3,
      maxCacheSize: adaptiveCacheSize,
      maxConcurrentTTS: 2,      // Process 2 batches concurrently
      batchCharLimit: 600,      // Smaller batches = less post-processing overhead
      singleSentenceLimit: 600, // More sentences skip batch splitting (processed individually)
      enableASR: false,         // Default disabled to save ~50MB Parakeet model download
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
   * Set playback rate for conditional ASR optimization
   */
  setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
  }

  /**
   * Set audio cache context for cache key generation
   * Call this when voice or speech rate changes, or when switching books
   */
  setAudioCacheContext(bookId: string, voice: string, speechRate: number): void {
    this.currentBookId = bookId;
    this.currentVoice = voice;
    this.currentSpeechRate = speechRate;
  }

  /**
   * Enable or disable audio caching
   */
  setAudioCacheEnabled(enabled: boolean): void {
    this.audioCacheEnabled = enabled;
  }

  /**
   * Set the AudioContext for creating buffers
   */
  setAudioContext(context: AudioContext): void {
    this.audioContext = context;
  }

  /**
   * Check if AudioContext is set (for lazy initialization)
   */
  hasAudioContext(): boolean {
    return this.audioContext !== null;
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

    // Queue sentences with priorities - Optimization #2: use heap for O(log n) insert
    this.queue.clear();
    this.queuedIds.clear();  // Performance optimization #4
    toPreload.forEach((sentence, index) => {
      this.queue.push({
        sentence,
        priority: index,
        abortController: new AbortController()
      });
      this.queuedIds.add(sentence.id);  // Performance optimization #4
    });

    // Link abort controllers to session (use once: true to prevent listener accumulation)
    this.sessionController.signal.addEventListener('abort', () => {
      this.queue.toArray().forEach(req => req.abortController.abort());
      // Abort all active concurrent requests
      this.activeRequests.forEach(req => req.abortController.abort());
    }, { once: true });

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
    this.queue.clear();
    this.queuedIds.clear();  // Performance optimization #4
    // Abort and clear all active requests
    this.activeRequests.forEach(req => req.abortController.abort());
    this.activeRequests.clear();
  }

  /**
   * Process items in the queue concurrently (up to maxConcurrentTTS)
   * Batches consecutive short sentences together for efficiency
   * Optimization #2: Using min-heap eliminates need for O(n log n) sort
   */
  private processQueue(): void {
    // Continue spawning while under concurrency limit and queue has items
    while (
      this.activeRequests.size < this.config.maxConcurrentTTS &&
      this.queue.size > 0
    ) {
      // No need to sort - heap is already ordered by priority!

      // Try to batch consecutive short sentences
      const batch = this.collectBatch();
      if (!batch) break;

      if (batch.sentences.length === 1) {
        // Single sentence - process normally
        this.processSingleSentence(batch.sentences[0], batch.abortController, batch.priority);
      } else {
        // Multiple sentences - process as batch
        console.log(`[Preload] Batched ${batch.sentences.length} sentences (${batch.combinedText.length} chars)`);
        this.processBatchedRequest(batch);
      }
    }
  }

  /**
   * Collect consecutive short sentences into a batch
   * Optimization #2: Using heap peek()/pop() instead of [0]/shift()
   */
  private collectBatch(): BatchedRequest | null {
    if (this.queue.size === 0) return null;

    const batch: Sentence[] = [];
    const abortControllers: AbortController[] = [];
    let totalChars = 0;
    let priority = Infinity;

    // Collect consecutive short sentences
    while (this.queue.size > 0) {
      const next = this.queue.peek()!;
      const textLen = next.sentence.text.length;

      // Stop if sentence is too long to batch
      if (textLen > this.config.singleSentenceLimit) {
        if (batch.length === 0) {
          // First sentence is long - just return it alone
          this.queue.pop();
          this.queuedIds.delete(next.sentence.id);  // Performance optimization #4
          this.activeRequests.set(next.sentence.id, next);
          return {
            sentences: [next.sentence],
            combinedText: next.sentence.text,
            charBoundaries: [textLen],
            abortController: next.abortController,
            priority: next.priority
          };
        }
        break; // Stop batching, long sentence will be next batch
      }

      // Stop if adding would exceed batch limit
      if (totalChars + textLen > this.config.batchCharLimit && batch.length > 0) {
        break;
      }

      // Add to batch
      const request = this.queue.pop()!;
      this.queuedIds.delete(request.sentence.id);  // Performance optimization #4
      batch.push(request.sentence);
      abortControllers.push(request.abortController);
      totalChars += textLen;
      priority = Math.min(priority, request.priority);

      // Track in activeRequests
      this.activeRequests.set(request.sentence.id, request);
    }

    if (batch.length === 0) return null;

    // Build combined text and boundaries
    // Use preprocessed text if available, otherwise use raw text
    let combinedText = '';
    const charBoundaries: number[] = [];

    batch.forEach((sentence, i) => {
      if (i > 0) combinedText += ' ';  // Space between sentences
      combinedText += sentence.preprocessedText || sentence.text;
      charBoundaries.push(combinedText.length);
    });

    // Create linked abort controller (use once: true to prevent listener accumulation)
    const batchAbort = new AbortController();
    abortControllers.forEach(ac => {
      ac.signal.addEventListener('abort', () => batchAbort.abort(), { once: true });
    });

    return { sentences: batch, combinedText, charBoundaries, abortController: batchAbort, priority };
  }

  /**
   * Process a single sentence (non-batched)
   */
  private async processSingleSentence(sentence: Sentence, abortController: AbortController, priority: number): Promise<void> {
    try {
      // Check if cancelled before starting
      if (abortController.signal.aborted) {
        return;
      }

      // Check cache first
      if (this.audioCacheEnabled && this.currentBookId) {
        const cacheParams: AudioCacheParams = {
          bookId: this.currentBookId,
          chapterId: parseInt(sentence.chapterId) || 0,
          sentenceId: sentence.id,
          text: sentence.text,
          voice: this.currentVoice,
          speechRate: this.currentSpeechRate,
        };

        const cachedBlob = await this.audioCache.getCachedAudio(cacheParams);
        if (cachedBlob) {
          // Use cached audio
          const audio = await this.createSentenceAudioFromBlob(sentence, cachedBlob);

          // Evict old entries if cache is full
          this.evictIfNeeded();

          this.cache.set(sentence.id, audio);
          this.touchAccess(sentence.id);
          this.stateCallback?.(sentence.id, 'ready');
          this.config.onItemComplete?.(sentence.id, this.cache.size);
          console.log(`[Preload] Cache HIT for sentence: ${sentence.id}`);
          return;
        }
      }

      // Use fewer steps for urgent requests (priority 0 = current sentence)
      const totalSteps = priority === 0 ? this.config.urgentSteps : this.config.totalSteps;

      // Synthesize audio
      const result = await this.ttsManager.synthesize(
        sentence.text,
        {
          speed: this.config.speed,
          totalSteps: totalSteps,
          preprocessedText: sentence.preprocessedText
        },
        abortController.signal
      );

      // Evict old entries if cache is full
      this.evictIfNeeded();

      // Create SentenceAudio
      const audio = await this.createSentenceAudio(sentence, result);

      // Create blob URL NOW during preload (not lazily at playback time)
      // This prevents main thread stall during sentence transitions
      if (!audio.blobUrl) {
        // Optimization #3: Use pre-encoded wavBuffer from worker if available (avoids main thread encoding)
        const wavBuffer = audio.wavBuffer ?? float32ToWav(audio.rawPcm, audio.sampleRate);
        audio.blobUrl = this.createAndTrackBlobUrl(sentence.id, wavBuffer);
      }

      // Cache the result and track access
      this.cache.set(sentence.id, audio);
      this.touchAccess(sentence.id);

      // Update state to ready
      this.stateCallback?.(sentence.id, 'ready');

      // Notify that an item completed (for continuous queue extension)
      this.config.onItemComplete?.(sentence.id, this.cache.size);

      // Cache the result in service worker (async, non-blocking)
      if (this.audioCacheEnabled && this.currentBookId && audio.wavBuffer) {
        const cacheParams: AudioCacheParams = {
          bookId: this.currentBookId,
          chapterId: parseInt(sentence.chapterId) || 0,
          sentenceId: sentence.id,
          text: sentence.text,
          voice: this.currentVoice,
          speechRate: this.currentSpeechRate,
        };

        this.audioCache.cacheAudio(cacheParams, new Blob([audio.wavBuffer], { type: 'audio/wav' }))
          .catch(err => console.warn('[Preload] Failed to cache audio:', err));
      }

    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Cancelled - don't report as error
      } else {
        console.error('Preload failed for sentence:', sentence.id, error);
        this.stateCallback?.(sentence.id, 'error');
      }
    } finally {
      // Remove from active requests
      this.activeRequests.delete(sentence.id);
      // Continue processing queue to fill available slot
      this.processQueue();
    }
  }

  /**
   * Process a batch of sentences in a single TTS call
   */
  private async processBatchedRequest(batch: BatchedRequest): Promise<void> {
    try {
      if (batch.abortController.signal.aborted) return;

      // Use fewer steps for urgent requests (priority 0 = current sentence)
      const totalSteps = batch.priority === 0 ? this.config.urgentSteps : this.config.totalSteps;

      // Synthesize combined text
      // Note: batch.combinedText already uses preprocessed text from createBatch()
      const result = await this.ttsManager.synthesize(
        batch.combinedText,
        { speed: this.config.speed, totalSteps: totalSteps, preprocessedText: batch.combinedText },
        batch.abortController.signal
      );

      // Split audio and create SentenceAudio for each
      const audioObjects = await this.splitBatchedAudio(batch, result);

      // Cache each sentence's audio
      for (const audio of audioObjects) {
        this.evictIfNeeded();

        // Create blob URL NOW during preload (not lazily at playback time)
        // Note: For batched audio, wavBuffer is not available (was for whole batch), so we fallback to encoding
        if (!audio.blobUrl) {
          const wavBuffer = audio.wavBuffer ?? float32ToWav(audio.rawPcm, audio.sampleRate);
          audio.blobUrl = this.createAndTrackBlobUrl(audio.sentenceId, wavBuffer);
        }

        this.cache.set(audio.sentenceId, audio);
        this.touchAccess(audio.sentenceId);
        this.stateCallback?.(audio.sentenceId, 'ready');
        this.config.onItemComplete?.(audio.sentenceId, this.cache.size);
      }

    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Batch preload failed:', error);
        batch.sentences.forEach(s => this.stateCallback?.(s.id, 'error'));
      }
    } finally {
      batch.sentences.forEach(s => this.activeRequests.delete(s.id));
      this.processQueue();
    }
  }

  /**
   * Split batched audio into individual SentenceAudio objects
   */
  private async splitBatchedAudio(
    batch: BatchedRequest,
    result: TTSSynthesisResult
  ): Promise<SentenceAudio[]> {
    const { sentences, charBoundaries } = batch;
    const totalChars = charBoundaries[charBoundaries.length - 1];
    const totalSamples = result.wav.length;
    const totalDuration = result.duration;

    // Minimum samples per sentence (100ms at sample rate) to prevent short sentences from being skipped
    const minSamplesPerSentence = Math.ceil(result.sampleRate * 0.1);

    const audioObjects: SentenceAudio[] = [];
    let prevCharEnd = 0;
    let prevSampleEnd = 0;
    let prevTimeEnd = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const charEnd = charBoundaries[i];
      const charRatio = (charEnd - prevCharEnd) / totalChars;

      // Calculate sample and time boundaries (character-weighted)
      let sampleEnd = Math.floor(prevSampleEnd + charRatio * totalSamples);
      const timeEnd = prevTimeEnd + charRatio * totalDuration;

      // Ensure minimum audio length for short sentences
      // This prevents Math.floor() from rounding down to zero for very short sentences
      // Apply to ALL sentences including the last one
      const requestedSamples = sampleEnd - prevSampleEnd;
      if (requestedSamples < minSamplesPerSentence) {
        // Borrow samples from the remaining pool, but don't exceed total
        sampleEnd = Math.min(prevSampleEnd + minSamplesPerSentence, totalSamples);
      }

      // Slice audio for this sentence
      let sentenceWav = result.wav.slice(prevSampleEnd, sampleEnd);
      let sentenceDuration = timeEnd - prevTimeEnd;

      // If still no audio after minimum enforcement, create placeholder with silence
      // This prevents sentences from being skipped which causes audio offset issues
      if (sentenceWav.length === 0) {
        console.warn(`[PreloadQueueManager] Creating placeholder audio for sentence "${sentence.id}" (${sentence.text.slice(0, 30)}...)`);
        // Create 100ms of silence so sentence isn't skipped
        const silentSamples = Math.ceil(result.sampleRate * 0.1);
        sentenceWav = new Float32Array(silentSamples);
        sentenceDuration = 0.1;
      }

      // Skip WAV/blob URL creation here - defer until playback for faster preloading
      // Estimate word timings for this sentence
      const wordTimestamps = this.estimateWordTimings(sentence.text, sentenceDuration);

      audioObjects.push({
        sentenceId: sentence.id,
        text: sentence.text,
        rawPcm: sentenceWav,
        sampleRate: result.sampleRate,
        // blobUrl created lazily in getAudio() when needed for playback
        wordTimestamps,
        duration: sentenceDuration,
        timestampSource: 'estimated'
      });

      prevCharEnd = charEnd;
      prevSampleEnd = sampleEnd;
      prevTimeEnd = timeEnd;
    }

    return audioObjects;
  }

  /**
   * Evict oldest entries if cache exceeds max size
   */
  private evictIfNeeded(): void {
    const PROTECTION_WINDOW = 10;  // Protect current + next 10 sentences

    // Build set of protected sentence IDs using existing currentSentences
    const protectedIds = new Set<string>();
    if (this.currentSentences.length > 0) {
      const startIdx = Math.max(0, this.currentPlayingIndex);
      const endIdx = Math.min(startIdx + PROTECTION_WINDOW, this.currentSentences.length);
      for (let i = startIdx; i < endIdx; i++) {
        protectedIds.add(this.currentSentences[i].id);
      }
    }

    while (this.cache.size >= this.config.maxCacheSize && this.accessOrder.size > 0) {
      // Find oldest entry that is NOT protected - O(n) but only runs during eviction
      let toEvict: string | null = null;
      let oldestTime = Infinity;

      for (const [sentenceId, accessTime] of this.accessOrder) {
        if (!protectedIds.has(sentenceId) && accessTime < oldestTime) {
          oldestTime = accessTime;
          toEvict = sentenceId;
        }
      }

      // If all entries are protected, allow cache to grow temporarily
      if (toEvict === null) break;

      this.accessOrder.delete(toEvict);
      this.revokeBlob(toEvict);
      this.cache.delete(toEvict);
      // Don't change state on eviction - keeps visual state as 'ready'
      // When user reaches evicted sentence, prepareSentence will regenerate on-demand
    }
  }

  /**
   * Track access for LRU eviction - O(1) operation using Map
   * Fix #4: Replaced O(n²) indexOf+splice with O(1) Map.set()
   */
  private touchAccess(sentenceId: string): void {
    this.accessOrder.set(sentenceId, Date.now());
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
   * WAV/blob URL creation is deferred until getAudio() for faster preloading
   */
  private async createSentenceAudio(
    sentence: Sentence,
    result: TTSSynthesisResult
  ): Promise<SentenceAudio> {
    // Store raw PCM data - blob URL created lazily in getAudio() for faster preloading
    // Estimate word timings with character-weighted distribution
    const wordTimestamps = this.estimateWordTimings(sentence.text, result.duration);

    return {
      sentenceId: sentence.id,
      text: sentence.text,
      rawPcm: result.wav,
      sampleRate: result.sampleRate,
      wavBuffer: result.wavBuffer,  // Optimization #3: Pre-encoded WAV buffer from worker
      // blobUrl created lazily in getAudio() when needed for playback
      wordTimestamps,
      duration: result.duration,
      timestampSource: 'estimated' as const
    };
  }

  /**
   * Create a SentenceAudio object from cached blob
   * Used when retrieving audio from service worker cache
   */
  private async createSentenceAudioFromBlob(sentence: Sentence, blob: Blob): Promise<SentenceAudio> {
    const wavBuffer = await blob.arrayBuffer();
    const blobUrl = this.createAndTrackBlobUrl(sentence.id, wavBuffer);

    // Estimate duration from WAV header (44 bytes header, 44100 Hz, 16-bit mono)
    const dataSize = wavBuffer.byteLength - 44;
    const duration = dataSize / (44100 * 2);

    // We don't have raw PCM from cached blob, so create an empty Float32Array
    // This is okay because cached audio already has blobUrl and wavBuffer
    const rawPcm = new Float32Array(0);

    return {
      sentenceId: sentence.id,
      text: sentence.text,
      blobUrl,
      wavBuffer,
      rawPcm,
      duration,
      sampleRate: 44100,
      wordTimestamps: this.estimateWordTimings(sentence.text, duration),
      timestampSource: 'estimated',
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
   * Blob URL is created during preload (not lazily) to prevent main thread stall during transitions
   */
  getAudio(sentenceId: string): SentenceAudio | undefined {
    const audio = this.cache.get(sentenceId);
    if (audio) {
      this.touchAccess(sentenceId);
    }
    return audio;
  }


  /**
   * Get the next sentence's audio if available (for pre-warming)
   * Returns undefined if no next sentence or audio not ready
   */
  getNextSentenceAudio(): SentenceAudio | undefined {
    const nextIndex = this.currentPlayingIndex + 1;
    if (nextIndex >= this.currentSentences.length) return undefined;

    const nextSentence = this.currentSentences[nextIndex];
    if (!nextSentence) return undefined;

    const audio = this.cache.get(nextSentence.id);
    if (audio?.blobUrl) {
      return audio;
    }
    return undefined;
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

    // Check service worker cache before synthesizing
    if (this.audioCacheEnabled && this.currentBookId) {
      const cacheParams: AudioCacheParams = {
        bookId: this.currentBookId,
        chapterId: parseInt(sentence.chapterId) || 0,
        sentenceId: sentence.id,
        text: sentence.text,
        voice: this.currentVoice,
        speechRate: this.currentSpeechRate,
      };

      const cachedBlob = await this.audioCache.getCachedAudio(cacheParams);
      if (cachedBlob) {
        // Use cached audio
        const audio = await this.createSentenceAudioFromBlob(sentence, cachedBlob);
        this.evictIfNeeded();
        this.cache.set(sentence.id, audio);
        this.touchAccess(sentence.id);
        this.stateCallback?.(sentence.id, 'ready');
        console.log(`[Preload] Cache HIT for urgent sentence: ${sentence.id}`);
        return audio;
      }
    }

    // If worker is busy with preload, cancel it to prioritize this sentence
    // This ensures the user doesn't wait for background preload to complete
    if (this.ttsManager.isBusy() || this.ttsManager.queueLength() > 0) {
      console.log('[Preload] Cancelling preload to prioritize current sentence');

      // Cancel all queued and active TTS requests
      this.ttsManager.cancelAll();

      // Clear our internal queue and active requests
      // Don't change state - preloadFullChapter will re-mark items as 'preloading' when it re-queues them
      this.queue.clear();
      this.queuedIds.clear();  // Performance optimization #4
      this.activeRequests.clear();
    }

    // Update state
    this.stateCallback?.(sentence.id, 'preloading');

    try {
      // Use urgent steps for immediate playback (user is waiting)
      const result = await this.ttsManager.synthesize(
        sentence.text,
        {
          speed: this.config.speed,
          totalSteps: this.config.urgentSteps,
          preprocessedText: sentence.preprocessedText
        },
        signal
      );

      // Evict if needed
      this.evictIfNeeded();

      const audio = await this.createSentenceAudio(sentence, result);

      // Create blob URL immediately (user is waiting for playback anyway)
      // Optimization #3: Use pre-encoded wavBuffer from worker if available
      if (!audio.blobUrl) {
        const wavBuffer = audio.wavBuffer ?? float32ToWav(audio.rawPcm, audio.sampleRate);
        audio.blobUrl = this.createAndTrackBlobUrl(sentence.id, wavBuffer);
      }

      this.cache.set(sentence.id, audio);
      this.touchAccess(sentence.id);
      this.stateCallback?.(sentence.id, 'ready');

      // Cache the result in service worker (async, non-blocking)
      if (this.audioCacheEnabled && this.currentBookId && audio.wavBuffer) {
        const cacheParams: AudioCacheParams = {
          bookId: this.currentBookId,
          chapterId: parseInt(sentence.chapterId) || 0,
          sentenceId: sentence.id,
          text: sentence.text,
          voice: this.currentVoice,
          speechRate: this.currentSpeechRate,
        };

        this.audioCache.cacheAudio(cacheParams, new Blob([audio.wavBuffer], { type: 'audio/wav' }))
          .catch(err => console.warn('[Preload] Failed to cache audio:', err));
      }

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
    // Don't add if already cached, in queue, or being processed
    // Performance optimization #4: O(1) check using Set instead of O(n) array.some()
    if (this.cache.has(sentence.id)) return;
    if (this.queuedIds.has(sentence.id)) return;
    if (this.activeRequests.has(sentence.id)) return;

    // Add with priority 0 (highest) - heap will place at front
    this.queue.push({
      sentence,
      priority: 0,
      abortController: new AbortController()
    });
    this.queuedIds.add(sentence.id);  // Performance optimization #4

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
      // Performance optimization #4: O(1) check using Set instead of O(n) array.some()
      if (this.cache.has(sentence.id)) continue;
      if (this.queuedIds.has(sentence.id)) continue;
      if (this.activeRequests.has(sentence.id)) continue;

      // Respect char limit (but always allow at least one)
      if (toAdd.length > 0 && totalChars >= this.config.preloadCharLimit) {
        break;
      }

      toAdd.push(sentence);
      totalChars += sentence.text.length;
    }

    if (toAdd.length === 0) return;

    // Add to queue with priorities based on current queue size and active requests
    const basePriority = this.queue.size + this.activeRequests.size;
    toAdd.forEach((sentence, index) => {
      const abortController = new AbortController();

      // Link to session abort (use once: true to prevent listener accumulation)
      this.sessionController!.signal.addEventListener('abort', () => {
        abortController.abort();
      }, { once: true });

      this.queue.push({
        sentence,
        priority: basePriority + index,
        abortController
      });
      this.queuedIds.add(sentence.id);  // Performance optimization #4

      this.stateCallback?.(sentence.id, 'preloading');
    });

    // Continue processing if not already
    this.processQueue();
  }

  /**
   * Preload entire chapter without count/char limits
   * Processes all sentences from startIndex to end of chapter
   * Cache eviction (LRU, maxCacheSize) still applies to bound memory
   */
  preloadFullChapter(sentences: Sentence[], startIndex: number): void {
    // Cancel existing session
    this.cancelSession();
    this.sessionController = new AbortController();

    // Queue ALL remaining sentences (no count/char limits)
    const toPreload: Sentence[] = [];
    for (let i = startIndex; i < sentences.length; i++) {
      if (!this.cache.has(sentences[i].id)) {
        toPreload.push(sentences[i]);
      }
    }

    if (toPreload.length === 0) {
      return; // Nothing to preload
    }

    // Create queue with priorities - Optimization #2: use heap for O(log n) insert
    this.queue.clear();
    this.queuedIds.clear();  // Performance optimization #4
    toPreload.forEach((sentence, index) => {
      this.queue.push({
        sentence,
        priority: index,
        abortController: new AbortController()
      });
      this.queuedIds.add(sentence.id);  // Performance optimization #4
    });

    // Link abort controllers to session (use once: true to prevent listener accumulation)
    this.sessionController.signal.addEventListener('abort', () => {
      this.queue.toArray().forEach(req => req.abortController.abort());
      // Abort all active concurrent requests
      this.activeRequests.forEach(req => req.abortController.abort());
    }, { once: true });

    // Mark all as preloading
    toPreload.forEach(sentence => {
      this.stateCallback?.(sentence.id, 'preloading');
    });

    console.log(`[Preload] Queued ${toPreload.length} sentences for full chapter preload (maxConcurrent: ${this.config.maxConcurrentTTS})`);

    // Start processing
    this.processQueue();
  }

  /**
   * Check if a sentence is currently queued
   * Performance optimization #4: O(1) using Set instead of O(n) array.some()
   */
  isQueued(sentenceId: string): boolean {
    return this.queuedIds.has(sentenceId);
  }

  /**
   * Check if a sentence is currently being processed
   */
  isProcessing(sentenceId: string): boolean {
    return this.activeRequests.has(sentenceId);
  }

  /**
   * Clear all cached audio and revoke blob URLs
   */
  clearCache(): void {
    this.revokeAllBlobs();
    this.cache.clear();
    this.accessOrder.clear();
  }

  /**
   * Clear cache for sentences that match a predicate
   */
  clearCacheWhere(predicate: (sentenceId: string) => boolean): void {
    for (const [id] of this.cache) {
      if (predicate(id)) {
        this.revokeBlob(id);
        this.cache.delete(id);
        this.accessOrder.delete(id);
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

  // ============================================
  // ASR Refinement Methods
  // ============================================

  /**
   * Set callback for when ASR completes and upgrades timestamps
   */
  onASRComplete(callback: (sentenceId: string, timestamps: WordTimestamp[]) => void): void {
    this.asrCompleteCallback = callback;
  }

  /**
   * Update the current playing position for ASR scheduling
   * Called by AudioSyncService when playback advances
   */
  setCurrentPlayingIndex(index: number, sentences: Sentence[]): void {
    console.log(`[ASR] setCurrentPlayingIndex: index=${index}, sentences=${sentences.length}`);

    // Clear ASR queue when switching to a different chapter (sentences array changed)
    // This prevents holding references to old chapter's sentences
    if (this.currentSentences !== sentences && this.currentSentences.length > 0) {
      console.log('[ASR] Chapter changed, clearing ASR queue to release old sentence references');
      this.clearASRQueue();
    }

    this.currentPlayingIndex = index;
    this.currentSentences = sentences;

    // Queue current and upcoming sentences for ASR refinement
    this.maybeQueueForASR();
  }

  /**
   * Check if we have enough buffer to run ASR (5+ sentences ahead)
   * Skip ASR at high playback speeds (1.5x+) as precise timestamps are less critical
   */
  private canRunASR(): boolean {
    // Skip if ASR is disabled
    if (!this.config.enableASR) {
      return false;
    }

    // Skip ASR at high playback speeds
    if (this.playbackRate >= 1.5) {
      return false;
    }

    if (this.currentPlayingIndex < 0 || this.currentSentences.length === 0) {
      console.log('[ASR] canRunASR: false (no position or sentences)');
      return false;
    }

    let readyAhead = 0;
    for (let i = this.currentPlayingIndex + 1; i < this.currentSentences.length; i++) {
      if (this.cache.has(this.currentSentences[i].id)) {
        readyAhead++;
        if (readyAhead >= 5) {
          console.log(`[ASR] canRunASR: true (readyAhead=${readyAhead})`);
          return true;
        }
      } else {
        break; // Gap in cache, stop counting
      }
    }
    console.log(`[ASR] canRunASR: false (readyAhead=${readyAhead}, need 5+)`);
    return false;
  }

  /**
   * Queue sentences for ASR refinement when we're ahead enough
   * Performance optimization #8: Uses Set for O(1) membership checks
   */
  private maybeQueueForASR(): void {
    console.log('[ASR] maybeQueueForASR called');
    if (!this.canRunASR()) {
      console.log('[ASR] Skipping ASR - not enough buffer');
      return;
    }
    console.log('[ASR] Buffer sufficient, queueing sentences for ASR refinement');

    // Priority 1: Currently playing sentence (if still using estimated)
    const currentSentence = this.currentSentences[this.currentPlayingIndex];
    if (currentSentence) {
      const currentAudio = this.cache.get(currentSentence.id);
      // Performance optimization #8: O(1) Set lookup instead of O(n) array.includes()
      if (currentAudio?.timestampSource === 'estimated' &&
          !this.asrQueueSet.has(currentSentence.id) &&
          this.asrProcessing !== currentSentence.id) {
        this.asrQueue.unshift(currentSentence.id); // High priority
        this.asrQueueSet.add(currentSentence.id);
      }
    }

    // Priority 2: Next sentences in order
    for (let i = this.currentPlayingIndex + 1; i < this.currentSentences.length && i <= this.currentPlayingIndex + 3; i++) {
      const sentence = this.currentSentences[i];
      const audio = this.cache.get(sentence.id);
      // Performance optimization #8: O(1) Set lookup instead of O(n) array.includes()
      if (audio?.timestampSource === 'estimated' &&
          !this.asrQueueSet.has(sentence.id) &&
          this.asrProcessing !== sentence.id) {
        this.asrQueue.push(sentence.id);
        this.asrQueueSet.add(sentence.id);
      }
    }

    // Trigger processing if not already running
    if (!this.asrProcessing && this.asrQueue.length > 0) {
      this.processASRQueue();
    }
  }

  /**
   * Process the ASR queue in background
   * Performance optimization #8: Maintains Set sync when dequeuing
   */
  private async processASRQueue(): Promise<void> {
    console.log(`[ASR] processASRQueue: queue=${this.asrQueue.length}, processing=${this.asrProcessing}`);

    if (this.asrProcessing || this.asrQueue.length === 0) {
      console.log('[ASR] processASRQueue: skipping (already processing or empty queue)');
      return;
    }

    // Check if we still have enough buffer
    if (!this.canRunASR()) {
      console.log('[ASR] processASRQueue: skipping (buffer insufficient)');
      return;
    }

    const sentenceId = this.asrQueue.shift();
    if (!sentenceId) return;
    this.asrQueueSet.delete(sentenceId);  // Performance optimization #8: Keep Set in sync

    const audio = this.cache.get(sentenceId);
    if (!audio || audio.timestampSource === 'asr') {
      console.log(`[ASR] processASRQueue: skipping ${sentenceId} (not cached or already ASR)`);
      // Already processed or not in cache, try next
      this.processASRQueue();
      return;
    }

    console.log(`[ASR] Processing sentence: ${sentenceId}`);
    this.asrProcessing = sentenceId;

    try {
      // Ensure Parakeet is ready
      const parakeet = await this.ensureParakeetReady();

      // Extract audio data from raw PCM and resample for ASR (44.1kHz → 16kHz)
      const audioData = audio.rawPcm;
      const audio16k = resampleAudio(audioData, audio.sampleRate, 16000);

      // Run ASR
      const result = await parakeet.transcribe(audio16k, 16000);

      // Upgrade timestamps in cache
      if (result.words.length > 0) {
        this.upgradeTimestamps(sentenceId, result.words);
        console.log(`[ASR] Upgraded timestamps for sentence ${sentenceId} (${result.words.length} words)`);
      }

    } catch (error) {
      console.warn(`[ASR] Failed for sentence ${sentenceId}:`, error);
      // Keep estimated timings, don't retry
    } finally {
      this.asrProcessing = null;
      // Continue processing queue
      if (this.asrQueue.length > 0 && this.canRunASR()) {
        this.processASRQueue();
      }
    }
  }

  /**
   * Request persistent storage to get higher IndexedDB quota for model caching
   * This prevents large model files from being evicted by the browser
   */
  private async requestPersistentStorage(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      try {
        const isPersisted = await navigator.storage.persisted();
        if (!isPersisted) {
          const granted = await navigator.storage.persist();
          console.log(`[ASR] Persistent storage ${granted ? 'granted' : 'denied'}`);
        } else {
          console.log('[ASR] Persistent storage already granted');
        }
      } catch (e) {
        console.warn('[ASR] Could not request persistent storage:', e);
      }
    }
  }

  /**
   * Lazily initialize Parakeet ASR with proper promise tracking
   * Handles concurrent calls correctly by sharing the initialization promise
   */
  private async ensureParakeetReady(): Promise<ParakeetASR> {
    // If already initialized and no pending promise, return immediately
    if (this.parakeet && !this.parakeetInitPromise) {
      return this.parakeet;
    }

    // If initialization in progress, wait for it
    if (this.parakeetInitPromise) {
      return this.parakeetInitPromise;
    }

    // Start initialization and track the promise
    this.parakeetInitPromise = (async () => {
      // Request persistent storage for better caching of large model files
      await this.requestPersistentStorage();

      this.parakeet = getSharedParakeetASR();
      console.log('[ASR] Initializing Parakeet...');
      await this.parakeet.initialize();
      console.log('[ASR] Parakeet ready');
      return this.parakeet;
    })();

    try {
      const result = await this.parakeetInitPromise;
      return result;
    } finally {
      // Clear promise after completion (success or failure)
      this.parakeetInitPromise = null;
    }
  }

  /**
   * Start preloading Parakeet ASR in background (non-blocking)
   * Call this early (e.g., after TTS init) to have ASR ready when needed
   */
  preloadParakeet(): void {
    // Skip if ASR is disabled - saves ~50MB model download
    if (!this.config.enableASR) {
      return;
    }

    // Don't block - just start the initialization
    this.ensureParakeetReady().catch((error) => {
      console.warn('[ASR] Background preload failed:', error);
    });
  }

  /**
   * Upgrade timestamps for a cached sentence from estimated to ASR
   * Optimization #6: Uses requestIdleCallback to prevent micro-stutters during playback
   */
  private upgradeTimestamps(sentenceId: string, timestamps: WordTimestamp[]): void {
    const audio = this.cache.get(sentenceId);
    if (!audio) return;

    // Update cache immediately (needed for playback accuracy)
    audio.wordTimestamps = timestamps;
    audio.timestampSource = 'asr';

    // Defer callback to idle time to prevent blocking the audio playback RAF loop
    const notifyCallback = () => {
      this.asrCompleteCallback?.(sentenceId, timestamps);
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(notifyCallback, { timeout: 500 });
    } else {
      // Fallback for browsers without requestIdleCallback (Safari)
      setTimeout(notifyCallback, 0);
    }
  }

  /**
   * Clear ASR queue (e.g., when seeking)
   * Performance optimization #8: Also clears the Set
   */
  clearASRQueue(): void {
    this.asrQueue = [];
    this.asrQueueSet.clear();  // Performance optimization #8
    // Note: asrProcessing will complete on its own
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.cancelSession();
    this.clearASRQueue();
    this.revokeAllBlobs();
    this.cache.clear();
    this.accessOrder.clear();
    this.stateCallback = null;
    this.asrCompleteCallback = null;
    this.currentPlayingIndex = -1;
    this.currentSentences = [];

    // Dispose Parakeet ASR model to free ONNX session memory
    if (this.parakeet) {
      this.parakeet.dispose();
      this.parakeet = null;
    }
    this.parakeetInitPromise = null;
  }
}
