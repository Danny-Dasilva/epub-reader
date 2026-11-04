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

// js-hoist-regexp: hoisted module-level constant avoids recreating regex on every estimateWordTimings call
const WHITESPACE_RE = /\s+/;

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
  requests: QueuedRequest[];       // Per-sentence request objects (same order as sentences),
                                   // used for identity checks against activeRequests
  combinedText: string;            // Concatenated text
  charBoundaries: number[];        // Character positions where each sentence ends
  abortController: AbortController;
  priority: number;
}

/**
 * Urgent (prepareSentence) synthesis shared by every concurrent caller for the same id.
 * `waiters` counts callers still awaiting it; the synthesis itself is aborted only once
 * every waiting caller has aborted its own signal.
 */
interface UrgentRequest {
  promise: Promise<SentenceAudio>;
  controller: AbortController;
  waiters: number;
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');

export class PreloadQueueManager {
  private ttsManager: TTSWorkerManager;
  private cache: Map<string, SentenceAudio> = new Map();
  // Optimization #2: Use min-heap for O(log n) insertion instead of O(n log n) sort
  private queue = new MinHeap<QueuedRequest>((a, b) => a.priority - b.priority);
  // Performance optimization #4: O(1) queue membership check
  private queuedIds = new Set<string>();
  private activeRequests: Map<string, QueuedRequest> = new Map();  // Track concurrent TTS operations
  // Urgent in-flight work from prepareSentence(). Not counted against maxConcurrentTTS, but
  // every enqueue path treats it as "in flight" so the same sentence isn't synthesized twice.
  private urgentRequests: Map<string, UrgentRequest> = new Map();
  // Last visual state THIS manager emitted per sentence. Only ids we still own (last painted
  // 'queued'/'preloading'/'ready' by us) are reset to 'pending'. Ownership is released when
  // playback reaches a sentence, so AudioSyncService's 'playing'/'played' is never stomped.
  private emittedState: Map<string, SentenceAudioState> = new Map();
  private disposed = false;
  private sessionController: AbortController | null = null;
  // Identity of the sentence list the current full-chapter preload session was started for.
  // Used to make preloadFullChapter idempotent: re-calling it for the SAME chapter must not
  // cancel + re-queue (which aborts in-flight synthesis and starves the look-ahead cache).
  private preloadSessionSentences: Sentence[] | null = null;
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

    // Align concurrency with the REAL number of TTS workers. Previously this was a
    // phantom 6 even though a single worker serialized everything, so look-ahead
    // never actually ran ahead of playback. With a worker pool of N, we allow N
    // concurrent synthesis jobs (+1 small slack so a job can be staged while the
    // worker drains the current one), so worker 1 synthesizes N+1 while worker 0
    // plays N.
    const workerCount =
      typeof (ttsManager as { getWorkerCount?: () => number }).getWorkerCount === 'function'
        ? (ttsManager as { getWorkerCount: () => number }).getWorkerCount()
        : 1;

    this.config = {
      preloadCount: 4,
      preloadCharLimit: 800,
      speed: 1.0,
      totalSteps: 5,        // Supertonic 2 is clean at 5 steps (no clipping)
      urgentSteps: 3,       // fast path for the current sentence; v2 doesn't clip at 3 (peak ~0.29)
      maxCacheSize: adaptiveCacheSize,
      maxConcurrentTTS: workerCount + 1,  // Match real worker pool (no phantom queue)
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
    // Cancel existing session (repaint of cancelled ids deferred until re-queue is done)
    const cancelled = this.cancelSessionInternal();

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

      // Skip if already cached or being synthesized on the urgent path
      if (!this.cache.has(sentence.id) && !this.urgentRequests.has(sentence.id)) {
        toPreload.push(sentence);
      }

      totalChars += sentence.text.length;
    }

    // Queue sentences with priorities - Optimization #2: use heap for O(log n) insert
    // js-combine-iterations: queue push and stateCallback in a single pass over toPreload
    this.queue.clear();
    this.queuedIds.clear();  // Performance optimization #4
    toPreload.forEach((sentence, index) => {
      this.queue.push({
        sentence,
        priority: index,
        abortController: new AbortController()
      });
      this.queuedIds.add(sentence.id);  // Performance optimization #4
      // 'queued' = waiting for a worker (static orange). Flips to 'preloading'
      // (pulsing orange) when synthesis actually starts, then 'ready'.
      this.emitState(sentence.id, 'queued');
    });

    // Link abort controllers to session (use once: true to prevent listener accumulation)
    this.sessionController.signal.addEventListener('abort', () => {
      for (const req of this.queue.toArray()) {
        req.abortController.abort();
      }
      for (const req of this.activeRequests.values()) {
        req.abortController.abort();
      }
    }, { once: true });

    // Cancelled sentences that weren't re-queued go back to 'pending'
    this.markCancelledPending(cancelled);

    // Start processing
    this.processQueue();
  }

  /**
   * Cancel the current session
   */
  cancelSession(): void {
    this.markCancelledPending(this.cancelSessionInternal());
  }

  /**
   * Abort the session and every queued/active background request (urgent prepareSentence
   * work is left alone). Returns the ids that were queued or in flight so the caller can
   * repaint them once it knows which ones it re-queued (avoids 'pending' -> 'queued' flicker).
   *
   * Clearing activeRequests here is safe: the finally blocks of the aborted
   * processSingleSentence/processBatchedRequest calls only delete their own request object
   * (identity check), so they can't remove entries for requests started after this point,
   * and they still call processQueue() to refill slots.
   */
  private cancelSessionInternal(): string[] {
    const cancelled = [...this.queuedIds, ...this.activeRequests.keys()];
    this.sessionController?.abort();
    this.sessionController = null;
    this.preloadSessionSentences = null;
    this.queue.clear();
    this.queuedIds.clear();  // Performance optimization #4
    // Abort and clear all active requests
    this.activeRequests.forEach(req => req.abortController.abort());
    this.activeRequests.clear();
    return cancelled;
  }

  // ============================================
  // Visual state ownership
  // ============================================

  /**
   * Emit a visual state and remember it as the last state this manager painted.
   */
  private emitState(sentenceId: string, state: SentenceAudioState): void {
    if (this.disposed) return;
    if (state === 'pending') {
      this.emittedState.delete(sentenceId);
    } else {
      this.emittedState.set(sentenceId, state);
    }
    this.stateCallback?.(sentenceId, state);
  }

  private isInFlight(sentenceId: string): boolean {
    return (
      this.queuedIds.has(sentenceId) ||
      this.activeRequests.has(sentenceId) ||
      this.urgentRequests.has(sentenceId)
    );
  }

  /**
   * After a cancellation: if the sentence is neither cached nor queued/in flight any more and
   * we last painted it 'queued'/'preloading', paint it 'pending'.
   */
  private markPendingIfCancelled(sentenceId: string): void {
    if (this.cache.has(sentenceId) || this.isInFlight(sentenceId)) return;
    const last = this.emittedState.get(sentenceId);
    if (last === 'queued' || last === 'preloading') {
      this.emitState(sentenceId, 'pending');
    }
  }

  private markCancelledPending(sentenceIds: Iterable<string>): void {
    for (const id of sentenceIds) {
      this.markPendingIfCancelled(id);
    }
  }

  /**
   * After cached audio was dropped: if we last painted the sentence 'ready', paint it 'pending'.
   */
  private markPendingIfEvicted(sentenceId: string): void {
    if (this.cache.has(sentenceId)) return;
    if (this.emittedState.get(sentenceId) === 'ready') {
      this.emitState(sentenceId, 'pending');
    }
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
        this.processSingleSentence(batch.requests[0], batch.abortController, batch.priority);
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
    const requests: QueuedRequest[] = [];
    const abortControllers: AbortController[] = [];
    let totalChars = 0;
    let priority = Infinity;

    // Collect consecutive short sentences
    while (this.queue.size > 0) {
      const next = this.queue.peek()!;

      // Skip items that were removed from queuedIds (cancelled or prioritized)
      if (!this.queuedIds.has(next.sentence.id)) {
        this.queue.pop(); // Remove from heap
        continue;
      }

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
            requests: [next],
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
      requests.push(request);
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

    return { sentences: batch, requests, combinedText, charBoundaries, abortController: batchAbort, priority };
  }

  /**
   * Process a single sentence (non-batched)
   */
  private async processSingleSentence(request: QueuedRequest, abortController: AbortController, priority: number): Promise<void> {
    const { sentence } = request;
    try {
      // Check if cancelled before starting
      if (abortController.signal.aborted) {
        return;
      }

      // Check cache first
      if (this.audioCacheEnabled && this.currentBookId) {
        const cachedBlob = await this.audioCache.getCachedAudio(this.cacheParamsFor(sentence));
        if (cachedBlob) {
          // Use cached audio
          const audio = await this.createSentenceAudioFromBlob(sentence, cachedBlob);
          if (this.commitAudio(audio)) {
            this.config.onItemComplete?.(sentence.id, this.cache.size);
            console.log(`[Preload] Cache HIT for sentence: ${sentence.id}`);
          }
          return;
        }
      }

      // Cancelled during the cache lookup, or another path (urgent) cached it meanwhile
      if (abortController.signal.aborted || this.cache.has(sentence.id)) {
        return;
      }

      // Synthesis is actually starting now → flip from 'queued' to 'preloading'
      // (pulsing orange). This is the moment the worker begins inference.
      this.emitState(sentence.id, 'preloading');

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

      // Create SentenceAudio
      const audio = await this.createSentenceAudio(sentence, result);

      // Evict, create the blob URL now (not lazily at playback time, which would stall the
      // main thread during sentence transitions), cache, and mark 'ready'. Skipped if another
      // path already cached this sentence.
      if (!this.commitAudio(audio)) return;

      // Notify that an item completed (for continuous queue extension)
      this.config.onItemComplete?.(sentence.id, this.cache.size);

      // Cache the result in service worker (async, non-blocking)
      if (this.audioCacheEnabled && this.currentBookId && audio.wavBuffer) {
        this.audioCache.cacheAudio(this.cacheParamsFor(sentence), new Blob([audio.wavBuffer], { type: 'audio/wav' }))
          .catch(err => console.warn('[Preload] Failed to cache audio:', err));
      }

    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Cancelled - don't report as error (repainted 'pending' in finally if needed)
      } else {
        console.error('Preload failed for sentence:', sentence.id, error);
        this.emitState(sentence.id, 'error');
      }
    } finally {
      // Remove from active requests - only if the slot still holds THIS request. If it was
      // cancelled and a newer request for the same id has since started, leave that one.
      if (this.activeRequests.get(sentence.id) === request) {
        this.activeRequests.delete(sentence.id);
      }
      if (abortController.signal.aborted) {
        this.markPendingIfCancelled(sentence.id);
      }
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

      // Synthesis starting for the whole batch → flip each from 'queued' to
      // 'preloading' (pulsing orange).
      for (const s of batch.sentences) {
        this.emitState(s.id, 'preloading');
      }

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

      // Cache each sentence's audio (blob URL created now; for batched audio there is no
      // per-sentence wavBuffer, so commitAudio falls back to encoding). Sentences another
      // path cached meanwhile keep their existing entry.
      for (const audio of audioObjects) {
        if (this.commitAudio(audio)) {
          this.config.onItemComplete?.(audio.sentenceId, this.cache.size);
        }
      }

    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Batch preload failed:', error);
        for (const s of batch.sentences) {
          this.emitState(s.id, 'error');
        }
      }
    } finally {
      const aborted = batch.abortController.signal.aborted;
      for (const req of batch.requests) {
        const id = req.sentence.id;
        // Identity check: don't delete a newer request for the same id. (queuedIds is not
        // touched here: collectBatch already removed these ids, and deleting again would
        // orphan a re-queued entry for the same sentence.)
        if (this.activeRequests.get(id) === req) {
          this.activeRequests.delete(id);
        }
        if (aborted) {
          this.markPendingIfCancelled(id);
        }
      }
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

    // js-cache-property-access: read once before the loop to avoid repeated property chain traversal
    const maxCacheSize = this.config.maxCacheSize;
    while (this.cache.size >= maxCacheSize && this.accessOrder.size > 0) {
      let toEvict: string | null = null;
      let oldestTime = Infinity;

      for (const [sentenceId, accessTime] of this.accessOrder) {
        if (protectedIds.has(sentenceId)) continue;
        if (accessTime < oldestTime) {
          oldestTime = accessTime;
          toEvict = sentenceId;
        }
      }

      if (toEvict === null) break;

      this.accessOrder.delete(toEvict);
      this.revokeBlob(toEvict);
      this.cache.delete(toEvict);
      this.markPendingIfEvicted(toEvict);
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
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();
  }

  /**
   * Cache freshly produced audio: evict if needed, create its blob URL, store it, and mark it
   * 'ready'. Returns false (and changes nothing) if another path already cached this sentence,
   * so a late duplicate never replaces the entry or revokes a blob URL that may be playing.
   */
  private commitAudio(audio: SentenceAudio): boolean {
    if (this.cache.has(audio.sentenceId)) return false;

    this.evictIfNeeded();

    if (!audio.blobUrl) {
      // Optimization #3: Use pre-encoded wavBuffer from worker if available (avoids main thread encoding)
      const wavBuffer = audio.wavBuffer ?? float32ToWav(audio.rawPcm, audio.sampleRate);
      audio.blobUrl = this.createAndTrackBlobUrl(audio.sentenceId, wavBuffer);
    }

    this.cache.set(audio.sentenceId, audio);
    this.touchAccess(audio.sentenceId);
    this.emitState(audio.sentenceId, 'ready');
    return true;
  }

  private cacheParamsFor(sentence: Sentence): AudioCacheParams {
    return {
      bookId: this.currentBookId,
      chapterId: parseInt(sentence.chapterId) || 0,
      sentenceId: sentence.id,
      text: sentence.text,
      voice: this.currentVoice,
      speechRate: this.currentSpeechRate,
    };
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
    // Use word timestamps from TTS heuristic (based on actual predicted duration)
    return {
      sentenceId: sentence.id,
      text: sentence.text,
      rawPcm: result.wav,
      sampleRate: result.sampleRate,
      wavBuffer: result.wavBuffer,  // Optimization #3: Pre-encoded WAV buffer from worker
      // blobUrl created lazily in getAudio() when needed for playback
      wordTimestamps: result.wordTimestamps,  // TTS-predicted timestamps (~25ms accuracy)
      duration: result.duration,
      timestampSource: 'tts' as const
    };
  }

  /**
   * Create a SentenceAudio object from cached blob
   * Used when retrieving audio from service worker cache
   */
  private async createSentenceAudioFromBlob(sentence: Sentence, blob: Blob): Promise<SentenceAudio> {
    // Blob URL is created by commitAudio() once we know this audio is actually cached
    const wavBuffer = await blob.arrayBuffer();

    // Read the actual model rate from the PCM WAV header (Inflect is 24 kHz).
    const wavView = new DataView(wavBuffer);
    const sampleRate = wavView.getUint32(24, true);
    const blockAlign = wavView.getUint16(32, true);
    const dataSize = wavView.getUint32(40, true);
    const duration = dataSize / (sampleRate * blockAlign);

    // We don't have raw PCM from cached blob, so create an empty Float32Array
    // This is okay because cached audio has wavBuffer (blobUrl is added by commitAudio)
    const rawPcm = new Float32Array(0);

    return {
      sentenceId: sentence.id,
      text: sentence.text,
      wavBuffer,
      rawPcm,
      duration,
      sampleRate,
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
    const words = text.split(WHITESPACE_RE).filter(w => w.length > 0);
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
   * Returns cached audio or synthesizes it on the urgent path (urgentSteps).
   *
   * Concurrent calls for the same sentence share one synthesis. A caller's `signal` only
   * rejects that caller's await (AbortError); the shared synthesis is aborted once every
   * caller still waiting on it has aborted. Urgent work is not counted against
   * maxConcurrentTTS, but the background queue treats it as in flight and won't re-queue it.
   */
  async prepareSentence(
    sentence: Sentence,
    signal?: AbortSignal
  ): Promise<SentenceAudio> {
    // Check cache first (and update LRU)
    const cached = this.getAudio(sentence.id);
    if (cached) {
      // Caller is about to play it: AudioSyncService owns its colour from here on
      this.emittedState.delete(sentence.id);
      return cached;
    }
    if (signal?.aborted) throw abortError();

    const urgent = this.urgentRequests.get(sentence.id) ?? this.startUrgentRequest(sentence);
    return this.awaitUrgentRequest(sentence.id, urgent, signal);
  }

  /**
   * Register urgent work for a sentence and start it. Registration happens synchronously,
   * before any await, so prioritize/extendQueue/startSession/preloadFullChapter see it at once.
   */
  private startUrgentRequest(sentence: Sentence): UrgentRequest {
    const id = sentence.id;

    // If this specific sentence is already being processed in the background, cancel it and
    // retry on the urgent path. Otherwise let it queue naturally - no need to nuke all preloads.
    const existingRequest = this.activeRequests.get(id);
    if (existingRequest) {
      console.log(`[Preload] Cancelling existing request for sentence ${id} to retry`);
      existingRequest.abortController.abort();
      this.activeRequests.delete(id);
    }

    // Remove from queue if it's waiting there
    if (this.queuedIds.has(id)) {
      console.log(`[Preload] Removing sentence ${id} from queue to prioritize`);
      // Note: This leaves the item in the heap, but it will be skipped when dequeued
      // since we remove it from queuedIds. This is acceptable overhead.
      this.queuedIds.delete(id);
    }

    const controller = new AbortController();
    const urgent = { controller, waiters: 0 } as UrgentRequest;
    this.urgentRequests.set(id, urgent);
    urgent.promise = this.runUrgentRequest(sentence, controller.signal).finally(() => {
      if (this.urgentRequests.get(id) === urgent) {
        this.urgentRequests.delete(id);
      }
      if (controller.signal.aborted) {
        this.markPendingIfCancelled(id);
      }
    });
    return urgent;
  }

  /**
   * Await shared urgent work on behalf of one caller, honouring that caller's signal.
   */
  private awaitUrgentRequest(
    id: string,
    urgent: UrgentRequest,
    signal?: AbortSignal
  ): Promise<SentenceAudio> {
    urgent.waiters++;
    return new Promise<SentenceAudio>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        settled = true;
        urgent.waiters--;
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        finish();
        if (urgent.waiters === 0) {
          // Last interested caller gave up: abort the synthesis and unregister it now, so a
          // later prepareSentence() starts fresh instead of joining a dying request.
          if (this.urgentRequests.get(id) === urgent) {
            this.urgentRequests.delete(id);
          }
          urgent.controller.abort();
          this.markPendingIfCancelled(id);
        }
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      urgent.promise.then(
        audio => {
          if (settled) return;
          finish();
          // Caller is about to play it: AudioSyncService owns its colour from here on
          this.emittedState.delete(id);
          resolve(audio);
        },
        error => {
          if (settled) return;
          finish();
          reject(error);
        }
      );
    });
  }

  /**
   * The urgent synthesis itself (service-worker cache lookup, then urgentSteps synthesis).
   */
  private async runUrgentRequest(sentence: Sentence, signal: AbortSignal): Promise<SentenceAudio> {
    try {
      // Check service worker cache before synthesizing
      if (this.audioCacheEnabled && this.currentBookId) {
        const cachedBlob = await this.audioCache.getCachedAudio(this.cacheParamsFor(sentence));
        if (cachedBlob) {
          const audio = await this.createSentenceAudioFromBlob(sentence, cachedBlob);
          console.log(`[Preload] Cache HIT for urgent sentence: ${sentence.id}`);
          return this.commitAudio(audio) ? audio : (this.cache.get(sentence.id) ?? audio);
        }
      }

      if (signal.aborted) throw abortError();
      const raced = this.cache.get(sentence.id);
      if (raced) return raced;

      // Update state
      this.emitState(sentence.id, 'preloading');

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

      const audio = await this.createSentenceAudio(sentence, result);

      // Evict, create blob URL immediately (user is waiting for playback anyway), cache, 'ready'.
      // If a racing path cached it first, return that entry instead.
      if (!this.commitAudio(audio)) {
        return this.cache.get(sentence.id) ?? audio;
      }

      // Cache the result in service worker (async, non-blocking)
      if (this.audioCacheEnabled && this.currentBookId && audio.wavBuffer) {
        this.audioCache.cacheAudio(this.cacheParamsFor(sentence), new Blob([audio.wavBuffer], { type: 'audio/wav' }))
          .catch(err => console.warn('[Preload] Failed to cache audio:', err));
      }

      return audio;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.emitState(sentence.id, 'error');
      }
      throw error;
    }
  }

  /**
   * Add a sentence to the preload queue with high priority
   */
  prioritize(sentence: Sentence): void {
    // Already cached → nothing to do (it's 'ready').
    if (this.cache.has(sentence.id)) return;

    // Already queued or in-flight: don't re-enqueue, but DO re-emit the current
    // visual state so the moving look-ahead window repaints orange as playback
    // advances (previously this silently early-returned and the window stalled).
    if (this.queuedIds.has(sentence.id)) {
      this.emitState(sentence.id, 'queued');
      return;
    }
    if (this.activeRequests.has(sentence.id)) {
      this.emitState(sentence.id, 'preloading');
      return;
    }
    // Being synthesized on the urgent path (prepareSentence) - already in flight
    if (this.urgentRequests.has(sentence.id)) return;

    // Add with priority 0 (highest) - heap will place at front
    this.queue.push({
      sentence,
      priority: 0,
      abortController: new AbortController()
    });
    this.queuedIds.add(sentence.id);  // Performance optimization #4

    this.emitState(sentence.id, 'queued');
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
      if (this.urgentRequests.has(sentence.id)) continue;

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
    for (let i = 0; i < toAdd.length; i++) {
      const sentence = toAdd[i];
      const abortController = new AbortController();

      // Link to session abort (use once: true to prevent listener accumulation)
      this.sessionController!.signal.addEventListener('abort', () => {
        abortController.abort();
      }, { once: true });

      this.queue.push({
        sentence,
        priority: basePriority + i,
        abortController
      });
      this.queuedIds.add(sentence.id);

      this.emitState(sentence.id, 'queued');
    }

    // Continue processing if not already
    this.processQueue();
  }

  /**
   * Preload entire chapter without count/char limits
   * Processes all sentences from startIndex to end of chapter
   * Cache eviction (LRU, maxCacheSize) still applies to bound memory
   */
  preloadFullChapter(sentences: Sentence[], startIndex: number): void {
    // Idempotent: if a preload session is already running for THIS chapter, leave it
    // alone. The first call already queued the entire chapter, so in-flight synthesis
    // keeps filling the look-ahead cache. Re-entering on every sentence advance and
    // calling cancelSession() here was aborting the in-flight jobs and re-queueing from
    // scratch each step, so generation could never get ahead of playback.
    if (
      this.sessionController &&
      !this.sessionController.signal.aborted &&
      this.preloadSessionSentences === sentences
    ) {
      return;
    }

    // Cancel existing session (different chapter, or no active session). Repainting the
    // cancelled ids is deferred until re-queueing is done to avoid 'pending' -> 'queued' flicker.
    const cancelled = this.cancelSessionInternal();
    this.sessionController = new AbortController();
    this.preloadSessionSentences = sentences;

    // Queue ALL remaining sentences (no count/char limits)
    const toPreload: Sentence[] = [];
    for (let i = startIndex; i < sentences.length; i++) {
      const id = sentences[i].id;
      if (!this.cache.has(id) && !this.urgentRequests.has(id)) {
        toPreload.push(sentences[i]);
      }
    }

    if (toPreload.length === 0) {
      this.markCancelledPending(cancelled);
      return; // Nothing to preload
    }

    // Create queue with priorities - Optimization #2: use heap for O(log n) insert
    // js-combine-iterations: queue push and stateCallback in a single pass over toPreload
    this.queue.clear();
    this.queuedIds.clear();  // Performance optimization #4
    toPreload.forEach((sentence, index) => {
      this.queue.push({
        sentence,
        priority: index,
        abortController: new AbortController()
      });
      this.queuedIds.add(sentence.id);  // Performance optimization #4
      // 'queued' = waiting for a worker (static orange); becomes 'preloading'
      // (pulsing) at synthesis start, then 'ready'.
      this.emitState(sentence.id, 'queued');
    });

    // Link abort controllers to session (use once: true to prevent listener accumulation)
    this.sessionController.signal.addEventListener('abort', () => {
      for (const req of this.queue.toArray()) {
        req.abortController.abort();
      }
      for (const req of this.activeRequests.values()) {
        req.abortController.abort();
      }
    }, { once: true });

    console.log(`[Preload] Queued ${toPreload.length} sentences for full chapter preload (maxConcurrent: ${this.config.maxConcurrentTTS})`);

    // Cancelled sentences that weren't re-queued go back to 'pending'
    this.markCancelledPending(cancelled);

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
    return this.activeRequests.has(sentenceId) || this.urgentRequests.has(sentenceId);
  }

  /**
   * Clear all cached audio and revoke blob URLs
   */
  clearCache(): void {
    const cleared = [...this.cache.keys()];
    this.revokeAllBlobs();
    this.cache.clear();
    this.accessOrder.clear();
    for (const id of cleared) {
      this.markPendingIfEvicted(id);
    }
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
        this.markPendingIfEvicted(id);
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
    // Clear ASR queue when switching to a different chapter (sentences array changed)
    // This prevents holding references to old chapter's sentences
    if (this.currentSentences !== sentences && this.currentSentences.length > 0) {
      this.clearASRQueue();
    }

    this.currentPlayingIndex = index;
    this.currentSentences = sentences;

    // Playback has reached this sentence: AudioSyncService paints it 'playing'/'played' from
    // now on, so it's no longer ours to reset to 'pending' on eviction or cancellation.
    const current = sentences[index];
    if (current) {
      this.emittedState.delete(current.id);
    }

    // Reprioritize the next 1-2 sentences onto the fast path (urgentSteps).
    // preloadFullChapter queues every sentence with priority=index so only index 0
    // gets urgentSteps; by calling prioritize() here we push the imminent sentences
    // back to priority 0 so they synthesize with urgentSteps instead of totalSteps.
    for (let i = index + 1; i <= index + 2 && i < sentences.length; i++) {
      this.prioritize(sentences[i]);
    }

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
    this.disposed = true;  // No state emissions from here on (incl. late async completions)
    this.cancelSession();
    for (const urgent of this.urgentRequests.values()) {
      urgent.controller.abort();
    }
    this.urgentRequests.clear();
    this.emittedState.clear();
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
