/**
 * ASR (Automatic Speech Recognition) types for word-level timestamps
 */

export interface WordTimestamp {
  text: string;
  start: number;  // Start time in seconds
  end: number;    // End time in seconds
  confidence?: number;
}

export interface TranscriptionResult {
  text: string;
  words: WordTimestamp[];
  duration: number;
}

export interface ASRConfig {
  backend: 'webgpu' | 'wasm';
  encoderQuant: 'fp32' | 'fp16' | 'int8';
  decoderQuant: 'fp32' | 'fp16' | 'int8';
  cpuThreads?: number;
}

export type ASRProgressCallback = (progress: number, message: string) => void;
