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
  WorkerDurationResponse
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
  onChunk?: (audio: Float32Array, chunkIndex: number, isLast: boolean) => void;
}

export type TTSLoadProgressCallback = (modelName: string, current: number, total: number) => void;

export interface TTSDurationResult {
  duration: number;
  wordTimestamps: WordTimestamp[];
}

interface PendingRequest {
  resolve: (result: TTSSynthesisResult) => void;
  reject: (error: Error) => void;
  onProgress?: (step: number, totalSteps: number) => void;
  onChunk?: (audio: Float32Array, chunkIndex: number, isLast: boolean) => void;
  workerIndex: number; // Track which worker is handling this request
  isStreaming?: boolean;  // Track if this is a streaming request
}

interface PendingDurationRequest {
  resolve: (result: TTSDurationResult) => void;
  reject: (error: Error) => void;
}

export class TTSWorkerManager {
  private workers: Worker[] = [];
  private workerBusy: boolean[] = [];
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
  private requestQueue: Array<{ message: WorkerInMessage; id: string }> = [];
  private isReady = false;
  private backend: 'webgpu' | 'wasm' | null = null;
  private loadProgressCallback: TTSLoadProgressCallback | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

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

    if (this.readyPromise) {
      await this.readyPromise;
      return this.backend!;
    }

    this.loadProgressCallback = onProgress || null;

    // Create ready promise
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // js-cache-property-access: read window.location.origin once outside the worker loop
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

    // Create multiple workers
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker(new URL('./tts.worker.ts', import.meta.url), {
        type: 'module'
      });

      this.workerBusy[i] = false;
      this.workerReady[i] = false;

      // advanced-event-handler-refs: bind handler once per worker index to avoid
      // creating a new closure on every message event
      const workerIdx = i;
      worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
        this.handleWorkerMessage(event.data, workerIdx);
      };

      worker.onerror = (error) => {
        console.error(`TTS Worker ${workerIdx} error:`, error);
        if (this.readyReject) {
          this.readyReject(new Error(`Worker ${workerIdx} initialization failed`));
        }
      };

      this.workers[i] = worker;

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

    await this.readyPromise;
    return this.backend!;
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
        if (allReady) {
          this.isReady = true;
          this.readyResolve?.();
          this.loadProgressCallback = null;
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
        const pending = this.pendingRequests.get(chunkMsg.id);
        if (pending) {
          // Call chunk callback
          pending.onChunk?.(chunkMsg.audio, chunkMsg.chunkIndex, chunkMsg.isLast);

          // If this is the last chunk, resolve the promise and clean up
          if (chunkMsg.isLast) {
            // For streaming, we resolve with an empty result since audio was already streamed
            pending.resolve({
              wav: new Float32Array(0),
              wavBuffer: new ArrayBuffer(0),
              duration: 0,
              sampleRate: 44100,
              wordTimestamps: []  // Streaming doesn't include timestamps in chunk response
            });
            this.pendingRequests.delete(chunkMsg.id);
            // Mark this worker as not busy
            this.workerBusy[workerIndex] = false;
            this.processNextInQueue();
          }
        }
        break;
      }

      case 'complete': {
        const completeMsg = message as WorkerCompleteResponse;
        const pending = this.pendingRequests.get(completeMsg.id);
        if (pending) {
          pending.resolve({
            wav: completeMsg.wav,
            wavBuffer: completeMsg.wavBuffer,  // Optimization #3: Pre-encoded WAV buffer
            duration: completeMsg.duration,
            sampleRate: completeMsg.sampleRate,
            wordTimestamps: completeMsg.wordTimestamps  // Word-level timestamps from TTS heuristic
          });
          this.pendingRequests.delete(completeMsg.id);
        }
        // Mark this worker as not busy
        this.workerBusy[workerIndex] = false;
        this.processNextInQueue();
        break;
      }

      case 'duration': {
        const durationMsg = message as WorkerDurationResponse;
        const pending = this.pendingDurationRequests.get(durationMsg.id);
        if (pending) {
          pending.resolve({
            duration: durationMsg.duration,
            wordTimestamps: durationMsg.wordTimestamps
          });
          this.pendingDurationRequests.delete(durationMsg.id);
        }
        break;
      }

      case 'cancelled': {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          pending.reject(new DOMException('Synthesis cancelled', 'AbortError'));
          this.pendingRequests.delete(message.id);
        }
        // Mark this worker as not busy
        this.workerBusy[workerIndex] = false;
        this.processNextInQueue();
        break;
      }

      case 'error': {
        if (message.id) {
          // Check synthesis requests
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            pending.reject(new Error(message.message));
            this.pendingRequests.delete(message.id);
            // Mark this worker as not busy
            this.workerBusy[workerIndex] = false;
            this.processNextInQueue();
          }
          // Check duration requests
          const pendingDuration = this.pendingDurationRequests.get(message.id);
          if (pendingDuration) {
            pendingDuration.reject(new Error(message.message));
            this.pendingDurationRequests.delete(message.id);
          }
        } else {
          // Global error (e.g., init failure)
          this.readyReject?.(new Error(message.message));
        }
        break;
      }
    }
  }

  /**
   * Find an available worker
   */
  private findAvailableWorker(): number {
    for (let i = 0; i < this.numWorkers; i++) {
      if (!this.workerBusy[i]) {
        return i;
      }
    }
    return -1; // All workers busy
  }

  /**
   * Process the next request in the queue
   */
  private processNextInQueue(): void {
    if (this.requestQueue.length === 0) {
      return;
    }

    // Try to process queued requests with available workers
    const workerIndex = this.findAvailableWorker();
    if (workerIndex === -1) {
      return; // All workers busy
    }

    const next = this.requestQueue.shift();
    if (next && this.workers[workerIndex]) {
      this.workerBusy[workerIndex] = true;
      // Update the pending request to track which worker is handling it
      const pending = this.pendingRequests.get(next.id);
      if (pending) {
        pending.workerIndex = workerIndex;
      }
      this.workers[workerIndex].postMessage(next.message);

      // Try to process more if there are available workers
      if (this.requestQueue.length > 0) {
        this.processNextInQueue();
      }
    }
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
      throw new DOMException('Synthesis cancelled', 'AbortError');
    }

    const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;

    const promise = new Promise<TTSSynthesisResult>((resolve, reject) => {
      // Set up abort handler
      let abortHandler: (() => void) | null = null;
      if (signal) {
        abortHandler = () => {
          this.cancel(requestId);
          // Remove from queue if not yet processing
          this.requestQueue = this.requestQueue.filter(r => r.id !== requestId);
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const message: WorkerInMessage = {
        type: 'synthesizeStreaming',
        id: requestId,
        text,
        speed: options.speed ?? 1.0,
        totalSteps: options.totalSteps ?? 5,
        chunkDurationMs: options.chunkDurationMs ?? 500,
        preprocessedText: options.preprocessedText
      };

      // Find an available worker
      const workerIndex = this.findAvailableWorker();

      // Wrap resolve/reject to clean up abort handler
      const wrappedResolve = (result: TTSSynthesisResult) => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        resolve(result);
      };
      const wrappedReject = (error: Error) => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        reject(error);
      };

      if (workerIndex === -1) {
        // All workers busy, queue the request
        this.pendingRequests.set(requestId, {
          resolve: wrappedResolve,
          reject: wrappedReject,
          onProgress: options.onProgress,
          onChunk: options.onChunk,
          workerIndex: -1,
          isStreaming: true
        });
        this.requestQueue.push({ message, id: requestId });
      } else {
        // Worker available, send immediately
        this.workerBusy[workerIndex] = true;
        this.pendingRequests.set(requestId, {
          resolve: wrappedResolve,
          reject: wrappedReject,
          onProgress: options.onProgress,
          onChunk: options.onChunk,
          workerIndex,
          isStreaming: true
        });
        this.workers[workerIndex].postMessage(message);
      }
    });

    await promise;
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
      throw new DOMException('Synthesis cancelled', 'AbortError');
    }

    const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;

    const promise = new Promise<TTSSynthesisResult>((resolve, reject) => {
      // Set up abort handler
      let abortHandler: (() => void) | null = null;
      if (signal) {
        abortHandler = () => {
          this.cancel(requestId);
          // Remove from queue if not yet processing
          this.requestQueue = this.requestQueue.filter(r => r.id !== requestId);
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const message: WorkerInMessage = {
        type: 'synthesize',
        id: requestId,
        text,
        speed: options.speed ?? 1.0,
        totalSteps: options.totalSteps ?? 5,
        preprocessedText: options.preprocessedText
      };

      // Find an available worker
      const workerIndex = this.findAvailableWorker();

      // Wrap resolve/reject to clean up abort handler
      const wrappedResolve = (result: TTSSynthesisResult) => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        resolve(result);
      };
      const wrappedReject = (error: Error) => {
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        reject(error);
      };

      if (workerIndex === -1) {
        // All workers busy, queue the request
        this.pendingRequests.set(requestId, {
          resolve: wrappedResolve,
          reject: wrappedReject,
          onProgress: options.onProgress,
          workerIndex: -1 // Will be set when dequeued
        });
        this.requestQueue.push({ message, id: requestId });
      } else {
        // Worker available, send immediately
        this.workerBusy[workerIndex] = true;
        this.pendingRequests.set(requestId, {
          resolve: wrappedResolve,
          reject: wrappedReject,
          onProgress: options.onProgress,
          workerIndex
        });
        this.workers[workerIndex].postMessage(message);
      }
    });

    return promise;
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

    const requestId = `dur_${++this.requestIdCounter}_${Date.now()}`;

    const promise = new Promise<TTSDurationResult>((resolve, reject) => {
      this.pendingDurationRequests.set(requestId, { resolve, reject });

      const message: WorkerInMessage = {
        type: 'predictDuration',
        id: requestId,
        text,
        speed: options.speed ?? 1.0,
        preprocessedText: options.preprocessedText
      };

      // Duration prediction doesn't block synthesis workers
      // Just use the first available worker
      this.workers[0].postMessage(message);
    });

    return promise;
  }

  /**
   * Cancel a specific synthesis request
   */
  cancel(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      // FIX #5: Immediately remove from pending to prevent stale chunk processing
      // This ensures any chunks arriving after cancel are ignored
      this.pendingRequests.delete(requestId);

      if (pending.workerIndex >= 0) {
        // Send cancel to the worker handling this request
        const worker = this.workers[pending.workerIndex];
        if (worker) {
          worker.postMessage({ type: 'cancel', id: requestId } as WorkerInMessage);
        }
        // Mark worker as not busy since we've already cleaned up the request
        this.workerBusy[pending.workerIndex] = false;
        this.processNextInQueue();
      }
    }
  }

  /**
   * Cancel all pending synthesis requests
   */
  cancelAll(): void {
    // Clear the queue
    for (const item of this.requestQueue) {
      const pending = this.pendingRequests.get(item.id);
      if (pending) {
        pending.reject(new DOMException('Synthesis cancelled', 'AbortError'));
        this.pendingRequests.delete(item.id);
      }
    }
    this.requestQueue = [];

    // Clean up duration requests too
    this.pendingDurationRequests.forEach(pending => {
      pending.reject(new DOMException('Cancelled', 'AbortError'));
    });
    this.pendingDurationRequests.clear();

    // Cancel current processing on all workers
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

    // Send voice change to all workers
    for (const worker of this.workers) {
      if (worker) {
        worker.postMessage({
          type: 'setVoice',
          baseUrl,
          voiceStylePath
        } as WorkerInMessage);
      }
    }
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
    return this.workerBusy.some(busy => busy);
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
    for (const worker of this.workers) {
      worker?.terminate();
    }
    this.workers = [];
    this.workerBusy = [];
    this.workerReady = [];
    this.isReady = false;
    this.backend = null;
    this.pendingRequests.clear();
    this.requestQueue = [];
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
