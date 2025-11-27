declare module 'parakeet.js' {
  export interface ParakeetModelOptions {
    backend: 'webgpu' | 'wasm';
    encoderQuant?: 'fp32' | 'fp16' | 'int8';
    decoderQuant?: 'fp32' | 'fp16' | 'int8';
  }

  export interface ModelInfo {
    urls: Record<string, string>;
    filenames: Record<string, string>;
  }

  export interface TranscribeOptions {
    returnTimestamps?: boolean;
    returnConfidences?: boolean;
  }

  export interface WordResult {
    text: string;
    start: number;
    end: number;
    confidence?: number;
  }

  export interface TranscriptionResult {
    text: string;
    words?: WordResult[];
  }

  export interface ParakeetModelFromUrlsOptions {
    backend: 'webgpu' | 'wasm';
    cpuThreads?: number;
    [key: string]: any;
  }

  export class ParakeetModel {
    static fromUrls(options: ParakeetModelFromUrlsOptions): Promise<ParakeetModel>;
    transcribe(
      audio: Float32Array,
      sampleRate: number,
      options?: TranscribeOptions
    ): Promise<TranscriptionResult>;
    dispose(): void;
  }

  export function getParakeetModel(
    modelId: string,
    options: ParakeetModelOptions
  ): Promise<ModelInfo>;
}
