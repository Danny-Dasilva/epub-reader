/**
 * TTS Worker Manager
 * Provides a clean Promise-based API for interacting with the TTS Web Worker.
 * Handles request queuing, cancellation via AbortSignal, and error handling.
 */

import type {
  WorkerInMessage,
  WorkerOutMessage,
  WorkerCompleteResponse,
  WorkerProgressResponse,
  WorkerLoadingResponse,
  WorkerChunkResponse,
  WorkerDurationResponse,
  WorkerSynthesizeMessage,
  WorkerSynthesizeStreamingMessage
} from './tts.worker';
import { WordTimestamp } from '../asr/types';

export interface TTSSynthesisResult {
  wav: Float32Array;
  wavBuffer: ArrayBuffer;  // Optimization #3: Pre-encoded WAV buffer from worker
  duration: number;
  sampleRate: number;
  wordTimestamps: WordTimestamp[];  // Word-level timestamps from TTS heuristic
}

export interface TTSSynthesisOptions {
  speed?: number;
  totalSteps?: number;
  onProgress?: (step: number, totalSteps: number) => void;
  preprocessedText?: string;  // Optional: precomputed preprocessed text to skip preprocessing
}

export interface TTSStreamingOptions extends TTSSynthesisOptions {
  chunkDurationMs?: number;  // Target chunk duration in milliseconds (default: 500ms)
  onChunk?: (audio: Float32Array, chunkIndex: number, isLast: boolean, sampleRate: number) => void;
}

export type TTSLoadProgressCallback = (modelName: string, current: number, total: number) => void;

export interface TTSDurationResult {
  duration: number;
  sampleRate: number;
  wordTimestamps: WordTimestamp[];
}

interface PendingRequest {
  resolve: (result: TTSSynthesisResult) => void;
  reject: (error: Error) => void;
  onProgress?: (step: number, totalSteps: number) => void;
  onChunk?: (audio: Float32Array, chunkIndex: number, isLast: boolean, sampleRate: number) => void;
  workerIndex: number; // Worker running this request; -1 while still in requestQueue
  message: WorkerInMessage;
}

interface PendingDurationRequest {
  resolve: (result: TTSDurationResult) => void;
  reject: (error: Error) => void;
}

const cancelledError = () => new DOMException('Synthesis cancelled', 'AbortError');

/**
 * Request lifecycle
 * - A synthesis request lives in pendingRequests from submit until it settles.
 *   Settling always goes through takePending(), which removes the entry first, so
 *   each caller promise settles exactly once and any later worker messages for
 *   that id find nothing and fire no callbacks.
 * - workerActive[i] is the id of the job worker i is actually running. A worker is
 *   free only when it reports a terminal message ('complete', last 'chunk',
 *   'cancelled', 'error') for that id. Cancelling never frees a worker by itself;
 *   the worker's own 'cancelled' reply does.
 */
export class TTSWorkerManager {
  private workers: Worker[] = [];
  private workerActive: Array<string | null> = [];
  private pendingDurationRequests: Map<string, PendingDurationRequest> = new Map();
  private workerReady: boolean[] = [];
  // Pool size is gated behind available device memory. Each worker loads its OWN
  // ONNX session (~100-200MB), so only spin up a 2nd worker on machines with
  // enough RAM. On low-memory devices we stay at 1 worker to avoid OOM.
  // A 2nd worker lets preload synthesis run AHEAD of playback: while worker 0 is
  // busy synthesizing the currently-playing sentence, worker 1 picks up the next
  // queued sentence (concurrent inference is safe across separate sessions).
  private numWorkers = TTSWorkerManager.computePoolSize();

  /**
   * Decide the worker-pool size based on available device memory.
   * navigator.deviceMemory is RAM in GB (undefined on some browsers → assume 4).
   * >= 8GB → 2 workers (real look-ahead); otherwise 1 worker (conservative).
   */
  private static computePoolSize(): number {
    const deviceMemory =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
        : undefined;
    return (deviceMemory ?? 4) >= 8 ? 2 : 1;
  }

  /**
   * Number of TTS workers in the pool (model loads = sessions = this count).
   */
  getWorkerCount(): number {
    return this.numWorkers;
  }
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestQueue: string[] = [];
  private isReady = false;
  private backend: 'webgpu' | 'wasm' | null = null;
  private loadProgressCallback: TTSLoadProgressCallback | null = null;
  // Shared by concurrent initialize() callers. Non-null readyReject means an init
  // is in flight; on failure everything is reset so a later initialize() retries.
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private voiceChange: {
    path: string;
    remainingWorkers: Set<number>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  private requestIdCounter = 0;

  /**
   * Initialize the worker pool and load TTS models
   */
  async initialize(
    onnxDir: string,
    voiceStylePath: string,
    onProgress?: TTSLoadProgressCallback,
    enableLazyVoiceLoading?: boolean
  ): Promise<'webgpu' | 'wasm'> {
    if (this.isReady && this.backend) {
      return this.backend;
    }

    const readyPromise =
      this.readyPromise ?? this.startWorkers(onnxDir, voiceStylePath, onProgress, enableLazyVoiceLoading);
    await readyPromise;
    return this.backend!;
  }

  private startWorkers(
    onnxDir: string,
    voiceStylePath: string,
    onProgress?: TTSLoadProgressCallback,
    enableLazyVoiceLoading?: boolean
  ): Promise<void> {
    this.loadProgressCallback = onProgress || null;

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise = readyPromise;

    // js-cache-property-access: read window.location.origin once outside the worker loop
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

    try {
      for (let i = 0; i < this.numWorkers; i++) {
        const worker = new Worker(new URL('./tts.worker.ts', import.meta.url), {
          type: 'module'
        });

        this.workerActive[i] = null;
        this.workerReady[i] = false;
        this.workers[i] = worker;

        // advanced-event-handler-refs: bind handler once per worker index to avoid
        // creating a new closure on every message event
        const workerIdx = i;
        worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
          if (this.workers[workerIdx] !== worker) return;
          this.handleWorkerMessage(event.data, workerIdx);
        };

        worker.onerror = (error) => {
          if (this.workers[workerIdx] !== worker) return;
          console.error(`TTS Worker ${workerIdx} error:`, error);
          if (this.readyReject) {
            this.failInit(new Error(`Worker ${workerIdx} initialization failed`));
          } else {
            this.handleWorkerFault(workerIdx, error);
          }
        };

        // Send init message with baseUrl for absolute URL construction in worker.
        // When pooling (numWorkers > 1) we halve per-worker WASM threads to avoid
        // CPU oversubscription across the two concurrent ONNX sessions.
        const numThreads = this.numWorkers > 1 ? 2 : 4;
        worker.postMessage({
          type: 'init',
          baseUrl,
          onnxDir,
          voiceStylePath,
          enableLazyVoiceLoading,
          numThreads
        } as WorkerInMessage);
      }
    } catch (error) {
      this.failInit(error instanceof Error ? error : new Error(String(error)));
    }

    return readyPromise;
  }

  /**
   * Abort an in-flight initialize(): terminate the workers it created, reset pool
   * state so a later initialize() starts over, and reject the shared promise.
   */
  private failInit(error: Error): void {
    const reject = this.readyReject;
    if (!reject) return;
    for (const worker of this.workers) {
      worker?.terminate();
    }
    this.workers = [];
    this.workerActive = [];
    this.workerReady = [];
    this.isReady = false;
    this.backend = null;
    this.loadProgressCallback = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    reject(error);
  }

  /**
   * An uncaught worker error leaves its ability to process messages unknown.
   * Tear down the pool and reject every operation, including duration and voice
   * requests, so no caller waits forever and initialization can retry.
   */
  private handleWorkerFault(workerIndex: number, error: ErrorEvent): void {
    const failure = new Error(`TTS worker ${workerIndex} error: ${error.message || 'unknown error'}`);
    const pending = Array.from(this.pendingRequests.values());
    const durations = Array.from(this.pendingDurationRequests.values());
    this.pendingRequests.clear();
    this.pendingDurationRequests.clear();
    this.requestQueue = [];
    for (const worker of this.workers) worker?.terminate();
    this.workers = [];
    this.workerActive = [];
    this.workerReady = [];
    this.isReady = false;
    this.backend = null;
    this.readyPromise = null;
    const voiceChange = this.voiceChange;
    this.voiceChange = null;
    for (const request of pending) request.reject(failure);
    for (const request of durations) request.reject(failure);
    voiceChange?.reject(failure);
  }

  /**
   * Remove a synthesis request so it can be settled. Returns undefined if it was
   * already settled (cancelled, completed, failed).
   */
  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return undefined;
    this.pendingRequests.delete(requestId);
    if (pending.workerIndex === -1) {
      const queueIndex = this.requestQueue.indexOf(requestId);
      if (queueIndex !== -1) this.requestQueue.splice(queueIndex, 1);
    }
    return pending;
  }

  /**
   * The worker reported a terminal message for requestId. Free it only if that is
   * the job it is currently running.
   */
  private releaseWorker(workerIndex: number, requestId: string): void {
    if (this.workerActive[workerIndex] !== requestId) return;
    this.workerActive[workerIndex] = null;
    this.processNextInQueue();
  }

  /**
   * Handle messages from a worker
   */
  private handleWorkerMessage(message: WorkerOutMessage, workerIndex: number): void {
    switch (message.type) {
      case 'ready': {
        // Track worker ready state
        this.workerReady[workerIndex] = true;
        if (!this.backend) {
          this.backend = message.backend;
        }

        // Check if all workers are ready
        const allReady = this.workerReady.every(ready => ready);
        if (allReady && this.readyResolve) {
          const resolve = this.readyResolve;
          this.isReady = true;
          this.readyResolve = null;
          this.readyReject = null;
          this.loadProgressCallback = null;
          resolve();
        }
        break;
      }

      case 'loading': {
        const loadMsg = message as WorkerLoadingResponse;
        // Report loading progress from any worker
        this.loadProgressCallback?.(loadMsg.modelName, loadMsg.current, loadMsg.total);
        break;
      }

      case 'progress': {
        const progressMsg = message as WorkerProgressResponse;
        const pending = this.pendingRequests.get(progressMsg.id);
        pending?.onProgress?.(progressMsg.step, progressMsg.totalSteps);
        break;
      }

      case 'chunk': {
        const chunkMsg = message as WorkerChunkResponse;
        const sampleRate = chunkMsg.sampleRate ?? 44100;
        const pending = this.pendingRequests.get(chunkMsg.id);
        if (pending) {
          let callbackError: unknown = null;
          try {
            pending.onChunk?.(chunkMsg.audio, chunkMsg.chunkIndex, chunkMsg.isLast, sampleRate);
          } catch (error) {
            callbackError = error;
          }

          if (callbackError !== null) {
            // A throwing consumer fails the request; remaining chunks are ignored
            // and the worker is told to stop (it still frees itself via its reply).
            this.takePending(chunkMsg.id)?.reject(
              callbackError instanceof Error ? callbackError : new Error(String(callbackError))
            );
            if (!chunkMsg.isLast) {
              this.workers[workerIndex]?.postMessage({ type: 'cancel', id: chunkMsg.id } as WorkerInMessage);
            }
          } else if (chunkMsg.isLast) {
            // For streaming, we resolve with an empty result since audio was already streamed
            this.takePending(chunkMsg.id)?.resolve({
              wav: new Float32Array(0),
              wavBuffer: new ArrayBuffer(0),
              duration: 0,
              sampleRate,
              wordTimestamps: []  // Streaming doesn't include timestamps in chunk response
            });
          }
        }
        if (chunkMsg.isLast) {
          this.releaseWorker(workerIndex, chunkMsg.id);
        }
        break;
      }

      case 'complete': {
        const completeMsg = message as WorkerCompleteResponse;
        this.takePending(completeMsg.id)?.resolve({
          wav: completeMsg.wav,
          wavBuffer: completeMsg.wavBuffer,  // Optimization #3: Pre-encoded WAV buffer
          duration: completeMsg.duration,
          sampleRate: completeMsg.sampleRate,
          wordTimestamps: completeMsg.wordTimestamps  // Word-level timestamps from TTS heuristic
        });
        this.releaseWorker(workerIndex, completeMsg.id);
        break;
      }

      case 'duration': {
        // Ignored if cancelAll() already rejected and dropped the request.
        const durationMsg = message as WorkerDurationResponse;
        const pending = this.pendingDurationRequests.get(durationMsg.id);
        if (pending) {
          this.pendingDurationRequests.delete(durationMsg.id);
          pending.resolve({
            duration: durationMsg.duration,
            sampleRate: durationMsg.sampleRate ?? 44100,
            wordTimestamps: durationMsg.wordTimestamps
          });
        }
        break;
      }

      case 'voiceChanged': {
        const change = this.voiceChange;
        if (!change || change.path !== message.voiceStylePath) break;
        change.remainingWorkers.delete(workerIndex);
        if (change.remainingWorkers.size === 0) {
          this.voiceChange = null;
          change.resolve();
        }
        break;
      }

      case 'cancelled': {
        this.takePending(message.id)?.reject(cancelledError());
        this.releaseWorker(workerIndex, message.id);
        break;
      }

      case 'error': {
        if (message.id) {
          // Synthesis request (no-op if it was already cancelled)
          this.takePending(message.id)?.reject(new Error(message.message));
          this.releaseWorker(workerIndex, message.id);
          // Duration request
          const pendingDuration = this.pendingDurationRequests.get(message.id);
          if (pendingDuration) {
            this.pendingDurationRequests.delete(message.id);
            pendingDuration.reject(new Error(message.message));
          }
        } else {
          const error = new Error(message.message);
          if (this.readyReject) {
            // Global error during init (e.g., model load failure)
            this.failInit(error);
          } else if (this.voiceChange) {
            const change = this.voiceChange;
            this.voiceChange = null;
            change.reject(error);
          } else {
            console.error(`TTS Worker ${workerIndex} error:`, message.message);
          }
        }
        break;
      }
    }
  }

  /**
   * Find an available worker
   */
  private findAvailableWorker(): number {
    for (let i = 0; i < this.workers.length; i++) {
      if (this.workers[i] && this.workerActive[i] == null) {
        return i;
      }
    }
    return -1; // All workers busy
  }

  /**
   * Dispatch queued requests to free workers
   */
  private processNextInQueue(): void {
    while (this.requestQueue.length > 0) {
      const workerIndex = this.findAvailableWorker();
      if (workerIndex === -1) {
        return; // All workers busy
      }

      const id = this.requestQueue.shift()!;
      const pending = this.pendingRequests.get(id);
      if (!pending) continue; // Settled while queued

      this.workerActive[workerIndex] = id;
      pending.workerIndex = workerIndex;
      this.workers[workerIndex].postMessage(pending.message);
    }
  }

  /**
   * Queue a synthesis request and wire up abort handling. The returned promise
   * settles exactly once; aborting rejects it with DOMException('AbortError').
   */
  private submit(
    message: WorkerSynthesizeMessage | WorkerSynthesizeStreamingMessage,
    options: TTSStreamingOptions,
    signal?: AbortSignal
  ): Promise<TTSSynthesisResult> {
    const requestId = message.id;
    return new Promise<TTSSynthesisResult>((resolve, reject) => {
      const abortHandler = () => this.cancel(requestId);
      signal?.addEventListener('abort', abortHandler, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', abortHandler);

      this.pendingRequests.set(requestId, {
        resolve: (result) => { cleanup(); resolve(result); },
        reject: (error) => { cleanup(); reject(error); },
        onProgress: options.onProgress,
        onChunk: options.onChunk,
        workerIndex: -1, // Set when dispatched
        message
      });
      this.requestQueue.push(requestId);
      this.processNextInQueue();
    });
  }

  private nextRequestId(prefix: string): string {
    return `${prefix}_${++this.requestIdCounter}_${Date.now()}`;
  }

  /**
   * Synthesize text to speech with streaming output
   * Emits audio chunks as they're generated for faster time-to-first-audio
   */
  async synthesizeStreaming(
    text: string,
    options: TTSStreamingOptions = {},
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.isReady || this.workers.length === 0) {
      throw new Error('Worker not initialized');
    }

    // Check if already aborted
    if (signal?.aborted) {
      throw cancelledError();
    }

    await this.submit({
      type: 'synthesizeStreaming',
      id: this.nextRequestId('req'),
      text,
      speed: options.speed ?? 1.0,
      totalSteps: options.totalSteps ?? 5,
      chunkDurationMs: options.chunkDurationMs ?? 500,
      preprocessedText: options.preprocessedText
    }, options, signal);
  }

  /**
   * Synthesize text to speech
   */
  async synthesize(
    text: string,
    options: TTSSynthesisOptions = {},
    signal?: AbortSignal
  ): Promise<TTSSynthesisResult> {
    if (!this.isReady || this.workers.length === 0) {
      throw new Error('Worker not initialized');
    }

    // Check if already aborted
    if (signal?.aborted) {
      throw cancelledError();
    }

    return this.submit({
      type: 'synthesize',
      id: this.nextRequestId('req'),
      text,
      speed: options.speed ?? 1.0,
      totalSteps: options.totalSteps ?? 5,
      preprocessedText: options.preprocessedText
    }, { onProgress: options.onProgress }, signal);
  }

  /**
   * Predict duration and get word timestamps without full synthesis.
   * Used for streaming path to get accurate timestamps before audio starts.
   */
  async predictDuration(
    text: string,
    options: { speed?: number; preprocessedText?: string } = {}
  ): Promise<TTSDurationResult> {
    if (!this.isReady || this.workers.length === 0) {
      throw new Error('Worker not initialized');
    }

    const requestId = this.nextRequestId('dur');

    const promise = new Promise<TTSDurationResult>((resolve, reject) => {
      this.pendingDurationRequests.set(requestId, { resolve, reject });

      const message: WorkerInMessage = {
        type: 'predictDuration',
        id: requestId,
        text,
        speed: options.speed ?? 1.0,
        preprocessedText: options.preprocessedText
      };

      // Duration prediction isn't tracked in workerActive; it serializes on
      // worker 0's inference mutex instead.
      this.workers[0].postMessage(message);
    });

    return promise;
  }

  /**
   * Cancel a specific synthesis request. Rejects its promise with an AbortError
   * immediately. An in-flight request keeps its worker busy until the worker
   * confirms with 'cancelled' (or finishes); late messages are ignored.
   */
  cancel(requestId: string): void {
    const pending = this.takePending(requestId);
    if (!pending) return;

    if (pending.workerIndex >= 0) {
      this.workers[pending.workerIndex]?.postMessage({ type: 'cancel', id: requestId } as WorkerInMessage);
    }
    pending.reject(cancelledError());
  }

  /**
   * Cancel all pending synthesis requests (queued and in-flight) and duration
   * requests. Every outstanding promise rejects with an AbortError immediately.
   */
  cancelAll(): void {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    this.requestQueue = [];
    for (const request of pending) {
      request.reject(cancelledError());
    }

    // Clean up duration requests too; late 'duration' replies are ignored.
    const pendingDurations = Array.from(this.pendingDurationRequests.values());
    this.pendingDurationRequests.clear();
    for (const request of pendingDurations) {
      request.reject(new DOMException('Cancelled', 'AbortError'));
    }

    // Cancel running and mutex-waiting jobs on all workers. Workers stay busy
    // until they reply 'cancelled' for the job they are running.
    for (const worker of this.workers) {
      if (worker) {
        worker.postMessage({ type: 'cancelAll' } as WorkerInMessage);
      }
    }
  }

  /**
   * Change the voice style
   */
  async setVoiceStyle(voiceStylePath: string): Promise<void> {
    if (this.workers.length === 0) {
      throw new Error('Worker not initialized');
    }

    // js-cache-property-access: read window.location.origin once outside the loop
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

    this.cancelAll();
    if (this.voiceChange) {
      this.voiceChange.reject(new DOMException('Voice change superseded', 'AbortError'));
      this.voiceChange = null;
    }

    await new Promise<void>((resolve, reject) => {
      const remainingWorkers = new Set<number>();
      for (let index = 0; index < this.workers.length; index++) {
        if (this.workers[index]) remainingWorkers.add(index);
      }
      this.voiceChange = { path: voiceStylePath, remainingWorkers, resolve, reject };
      for (const index of remainingWorkers) {
        this.workers[index].postMessage({
          type: 'setVoice',
          baseUrl,
          voiceStylePath
        } as WorkerInMessage);
      }
      if (remainingWorkers.size === 0) {
        this.voiceChange = null;
        resolve();
      }
    });
  }

  /**
   * Get the current backend
   */
  getBackend(): 'webgpu' | 'wasm' | null {
    return this.backend;
  }

  /**
   * Check if the worker is ready
   */
  ready(): boolean {
    return this.isReady;
  }

  /**
   * Check if currently processing
   */
  isBusy(): boolean {
    return this.workerActive.some(id => id != null);
  }

  /**
   * Get the number of queued requests
   */
  queueLength(): number {
    return this.requestQueue.length;
  }

  /**
   * Dispose of the worker pool
   */
  dispose(): void {
    this.cancelAll();
    // Rejects an in-flight initialize() and terminates its workers.
    this.failInit(new DOMException('Worker disposed', 'AbortError'));
    for (const worker of this.workers) {
      worker?.terminate();
    }
    this.workers = [];
    this.workerActive = [];
    this.workerReady = [];
    this.isReady = false;
    this.backend = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.voiceChange?.reject(new DOMException('Worker disposed', 'AbortError'));
    this.voiceChange = null;
  }
}

// Singleton instance
let sharedManager: TTSWorkerManager | null = null;

/**
 * Get the shared TTS worker manager instance
 */
export function getTTSWorkerManager(): TTSWorkerManager {
  if (!sharedManager) {
    sharedManager = new TTSWorkerManager();
  }
  return sharedManager;
}
