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
  WorkerLoadingResponse
} from './tts.worker';

export interface TTSSynthesisResult {
  wav: Float32Array;
  wavBuffer: ArrayBuffer;  // Optimization #3: Pre-encoded WAV buffer from worker
  duration: number;
  sampleRate: number;
}

export interface TTSSynthesisOptions {
  speed?: number;
  totalSteps?: number;
  onProgress?: (step: number, totalSteps: number) => void;
  preprocessedText?: string;  // Optional: precomputed preprocessed text to skip preprocessing
}

export type TTSLoadProgressCallback = (modelName: string, current: number, total: number) => void;

interface PendingRequest {
  resolve: (result: TTSSynthesisResult) => void;
  reject: (error: Error) => void;
  onProgress?: (step: number, totalSteps: number) => void;
  workerIndex: number; // Track which worker is handling this request
}

export class TTSWorkerManager {
  private workers: Worker[] = [];
  private workerBusy: boolean[] = [];
  private workerReady: boolean[] = [];
  private numWorkers = 1;
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
    onProgress?: TTSLoadProgressCallback
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

    // Create multiple workers
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker(new URL('./tts.worker.ts', import.meta.url), {
        type: 'module'
      });

      this.workerBusy[i] = false;
      this.workerReady[i] = false;

      // Set up message handler for this worker
      worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
        this.handleWorkerMessage(event.data, i);
      };

      worker.onerror = (error) => {
        console.error(`TTS Worker ${i} error:`, error);
        if (this.readyReject) {
          this.readyReject(new Error(`Worker ${i} initialization failed`));
        }
      };

      this.workers[i] = worker;

      // Send init message with baseUrl for absolute URL construction in worker
      worker.postMessage({
        type: 'init',
        baseUrl: typeof window !== 'undefined' ? window.location.origin : '',
        onnxDir,
        voiceStylePath
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

      case 'complete': {
        const completeMsg = message as WorkerCompleteResponse;
        const pending = this.pendingRequests.get(completeMsg.id);
        if (pending) {
          pending.resolve({
            wav: completeMsg.wav,
            wavBuffer: completeMsg.wavBuffer,  // Optimization #3: Pre-encoded WAV buffer
            duration: completeMsg.duration,
            sampleRate: completeMsg.sampleRate
          });
          this.pendingRequests.delete(completeMsg.id);
        }
        // Mark this worker as not busy
        this.workerBusy[workerIndex] = false;
        this.processNextInQueue();
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
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            pending.reject(new Error(message.message));
            this.pendingRequests.delete(message.id);
          }
          // Mark this worker as not busy
          this.workerBusy[workerIndex] = false;
          this.processNextInQueue();
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
      if (signal) {
        const abortHandler = () => {
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

      if (workerIndex === -1) {
        // All workers busy, queue the request
        this.pendingRequests.set(requestId, {
          resolve,
          reject,
          onProgress: options.onProgress,
          workerIndex: -1 // Will be set when dequeued
        });
        this.requestQueue.push({ message, id: requestId });
      } else {
        // Worker available, send immediately
        this.workerBusy[workerIndex] = true;
        this.pendingRequests.set(requestId, {
          resolve,
          reject,
          onProgress: options.onProgress,
          workerIndex
        });
        this.workers[workerIndex].postMessage(message);
      }
    });

    return promise;
  }

  /**
   * Cancel a specific synthesis request
   */
  cancel(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending && pending.workerIndex >= 0) {
      // Send cancel to the worker handling this request
      const worker = this.workers[pending.workerIndex];
      if (worker) {
        worker.postMessage({ type: 'cancel', id: requestId } as WorkerInMessage);
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

    // Send voice change to all workers
    for (const worker of this.workers) {
      if (worker) {
        worker.postMessage({
          type: 'setVoice',
          baseUrl: typeof window !== 'undefined' ? window.location.origin : '',
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

export function getSharedTTSWorkerManager(): TTSWorkerManager {
  if (!sharedManager) {
    sharedManager = new TTSWorkerManager();
  }
  return sharedManager;
}

export function disposeTTSWorkerManager(): void {
  sharedManager?.dispose();
  sharedManager = null;
}
