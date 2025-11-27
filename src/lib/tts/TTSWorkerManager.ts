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
  duration: number;
  sampleRate: number;
}

export interface TTSSynthesisOptions {
  speed?: number;
  totalSteps?: number;
  onProgress?: (step: number, totalSteps: number) => void;
}

export type TTSLoadProgressCallback = (modelName: string, current: number, total: number) => void;

interface PendingRequest {
  resolve: (result: TTSSynthesisResult) => void;
  reject: (error: Error) => void;
  onProgress?: (step: number, totalSteps: number) => void;
}

export class TTSWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestQueue: Array<{ message: WorkerInMessage; id: string }> = [];
  private isProcessing = false;
  private isReady = false;
  private backend: 'webgpu' | 'wasm' | null = null;
  private loadProgressCallback: TTSLoadProgressCallback | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  private requestIdCounter = 0;

  /**
   * Initialize the worker and load TTS models
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

    // Create the worker
    this.worker = new Worker(new URL('./tts.worker.ts', import.meta.url), {
      type: 'module'
    });

    // Set up message handler
    this.worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      this.handleWorkerMessage(event.data);
    };

    this.worker.onerror = (error) => {
      console.error('TTS Worker error:', error);
      if (this.readyReject) {
        this.readyReject(new Error('Worker initialization failed'));
      }
    };

    // Create ready promise
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Send init message with baseUrl for absolute URL construction in worker
    this.worker.postMessage({
      type: 'init',
      baseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      onnxDir,
      voiceStylePath
    } as WorkerInMessage);

    await this.readyPromise;
    return this.backend!;
  }

  /**
   * Handle messages from the worker
   */
  private handleWorkerMessage(message: WorkerOutMessage): void {
    switch (message.type) {
      case 'ready': {
        this.isReady = true;
        this.backend = message.backend;
        this.readyResolve?.();
        this.loadProgressCallback = null;
        break;
      }

      case 'loading': {
        const loadMsg = message as WorkerLoadingResponse;
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
            duration: completeMsg.duration,
            sampleRate: completeMsg.sampleRate
          });
          this.pendingRequests.delete(completeMsg.id);
        }
        this.isProcessing = false;
        this.processNextInQueue();
        break;
      }

      case 'cancelled': {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          pending.reject(new DOMException('Synthesis cancelled', 'AbortError'));
          this.pendingRequests.delete(message.id);
        }
        this.isProcessing = false;
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
          this.isProcessing = false;
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
   * Process the next request in the queue
   */
  private processNextInQueue(): void {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    const next = this.requestQueue.shift();
    if (next && this.worker) {
      this.isProcessing = true;
      this.worker.postMessage(next.message);
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
    if (!this.isReady || !this.worker) {
      throw new Error('Worker not initialized');
    }

    // Check if already aborted
    if (signal?.aborted) {
      throw new DOMException('Synthesis cancelled', 'AbortError');
    }

    const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;

    const promise = new Promise<TTSSynthesisResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        onProgress: options.onProgress
      });

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
        totalSteps: options.totalSteps ?? 5
      };

      // If worker is busy, queue the request
      if (this.isProcessing) {
        this.requestQueue.push({ message, id: requestId });
      } else {
        this.isProcessing = true;
        this.worker!.postMessage(message);
      }
    });

    return promise;
  }

  /**
   * Cancel a specific synthesis request
   */
  cancel(requestId: string): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'cancel', id: requestId } as WorkerInMessage);
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

    // Cancel current processing
    if (this.worker) {
      this.worker.postMessage({ type: 'cancelAll' } as WorkerInMessage);
    }
  }

  /**
   * Change the voice style
   */
  async setVoiceStyle(voiceStylePath: string): Promise<void> {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    this.worker.postMessage({
      type: 'setVoice',
      baseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      voiceStylePath
    } as WorkerInMessage);
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
    return this.isProcessing;
  }

  /**
   * Get the number of queued requests
   */
  queueLength(): number {
    return this.requestQueue.length;
  }

  /**
   * Dispose of the worker
   */
  dispose(): void {
    this.cancelAll();
    this.worker?.terminate();
    this.worker = null;
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
