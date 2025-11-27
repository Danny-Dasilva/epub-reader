import * as ort from 'onnxruntime-web';

export interface TTSConfig {
  ae: {
    sample_rate: number;
    base_chunk_size: number;
  };
  ttl: {
    chunk_compress_factor: number;
    latent_dim: number;
  };
}

export interface TTSResult {
  wav: number[];
  duration: number[];
}

export interface SynthesisOptions {
  totalStep?: number;
  speed?: number;
  silenceDuration?: number;
  onProgress?: (step: number, total: number) => void;
}

export interface LoadProgressCallback {
  (modelName: string, current: number, total: number): void;
}

export class Style {
  ttl: ort.Tensor;
  dp: ort.Tensor;

  constructor(ttlTensor: ort.Tensor, dpTensor: ort.Tensor) {
    this.ttl = ttlTensor;
    this.dp = dpTensor;
  }
}
