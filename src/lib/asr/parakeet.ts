/**
 * Parakeet.js wrapper for word-level timestamp extraction
 * Uses NVIDIA Parakeet-TDT 0.6B model for ASR
 */

import { ASRConfig, ASRProgressCallback, TranscriptionResult, WordTimestamp } from './types';
import type { ParakeetModel, getParakeetModel as GetParakeetModelFn } from 'parakeet.js';

// Dynamic import types
interface ParakeetModule {
  getParakeetModel: typeof GetParakeetModelFn;
  ParakeetModel: typeof ParakeetModel;
}

// Dynamic import to handle SSR
let parakeetModule: ParakeetModule | null = null;

async function getParakeetModule(): Promise<ParakeetModule> {
  if (!parakeetModule) {
    parakeetModule = await import('parakeet.js') as ParakeetModule;
  }
  return parakeetModule;
}

export class ParakeetASR {
  private model: ParakeetModel | null = null;
  private config: ASRConfig;
  private loadingPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(config: Partial<ASRConfig> = {}) {
    this.config = {
      backend: 'webgpu',
      encoderQuant: 'fp32',
      decoderQuant: 'int8',
      cpuThreads: 4,
      ...config
    };
  }

  async initialize(progressCallback?: ASRProgressCallback): Promise<void> {
    if (this.model) return;
    if (this.loadingPromise) return this.loadingPromise;

    const generation = this.generation;
    const loading = this.loadModel(generation, progressCallback);
    this.loadingPromise = loading;
    try {
      await loading;
    } finally {
      if (this.loadingPromise === loading) this.loadingPromise = null;
    }
  }

  private async loadModel(generation: number, progressCallback?: ASRProgressCallback): Promise<void> {
    progressCallback?.(0, 'Loading ASR module...');

    const { getParakeetModel, ParakeetModel } = await getParakeetModule();

    progressCallback?.(10, 'Fetching model info...');

    // Check WebGPU availability
    let backend = this.config.backend;
    if (backend === 'webgpu') {
      const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
      if (!hasWebGPU) {
        console.warn('WebGPU not available, falling back to WASM');
        backend = 'wasm';
      }
    }

    // Get model URLs from Hugging Face
    const modelInfo = await getParakeetModel('istupakov/parakeet-tdt-0.6b-v2-onnx', {
      backend,
      encoderQuant: this.config.encoderQuant,
      decoderQuant: this.config.decoderQuant
    });

    progressCallback?.(30, 'Downloading ASR models...');

    // Load the model
    const model = await ParakeetModel.fromUrls({
      ...modelInfo.urls,
      filenames: modelInfo.filenames,
      backend,
      cpuThreads: this.config.cpuThreads
    });

    if (generation !== this.generation) {
      model.dispose?.();
      throw new DOMException('ASR initialization cancelled', 'AbortError');
    }
    this.model = model;

    progressCallback?.(100, 'ASR ready');
  }

  async transcribe(
    audioData: Float32Array,
    sampleRate: number = 16000
  ): Promise<TranscriptionResult> {
    if (!this.model) {
      throw new Error('Model not initialized. Call initialize() first.');
    }

    // Parakeet expects 16kHz audio
    let processedAudio = audioData;
    if (sampleRate !== 16000) {
      processedAudio = this.resampleTo16k(audioData, sampleRate);
    }

    const result = await this.model.transcribe(processedAudio, 16000, {
      returnTimestamps: true,
      returnConfidences: true
    });

    const words: WordTimestamp[] = (result.words || []).map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      confidence: w.confidence
    }));

    return {
      text: result.text || '',
      words,
      duration: words.length > 0 ? words[words.length - 1].end : 0
    };
  }

  private resampleTo16k(audioData: Float32Array, fromSampleRate: number): Float32Array {
    const ratio = 16000 / fromSampleRate;
    // js-cache-property-access: cache audioData.length once to avoid repeated property lookups
    const srcLastIndex = audioData.length - 1;
    const newLength = Math.round((srcLastIndex + 1) * ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i / ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, srcLastIndex);
      const fraction = srcIndex - srcIndexFloor;

      result[i] = audioData[srcIndexFloor] * (1 - fraction) + audioData[srcIndexCeil] * fraction;
    }

    return result;
  }

  isReady(): boolean {
    return this.model !== null;
  }

  dispose(): void {
    this.generation++;
    this.loadingPromise = null;
    if (this.model && typeof this.model.dispose === 'function') {
      this.model.dispose();
    }
    this.model = null;
  }
}

// Singleton instance for app-wide use
let sharedInstance: ParakeetASR | null = null;

export function getSharedParakeetASR(config?: Partial<ASRConfig>): ParakeetASR {
  if (!sharedInstance) {
    sharedInstance = new ParakeetASR(config);
  }
  return sharedInstance;
}
