/**
 * Inflect TTS Web Worker
 *
 * Runs the per-voice duration and decode ONNX graphs off the main thread. The
 * public message protocol remains compatible with TTSWorkerManager so the
 * reader's preload, cancellation, and audio-cache layers can stay unchanged.
 */

import * as ort from 'onnxruntime-web';
import type { WordTimestamp } from '../asr/types';
import {
  applyEdgeFade,
  boundaryPauseSeconds,
  phonemesToTokenIds,
  phonemizeInflectText,
  splitInflectText,
  type InflectSymbolInventory,
} from './inflectFrontend';

export interface WorkerInitMessage {
  type: 'init';
  baseUrl: string;
  onnxDir: string;
  voiceStylePath: string;
  enableLazyVoiceLoading?: boolean;
  numThreads?: number;
}

export interface WorkerSynthesizeMessage {
  type: 'synthesize';
  id: string;
  text: string;
  speed: number;
  totalSteps: number;
  preprocessedText?: string;
}

export interface WorkerCancelMessage { type: 'cancel'; id: string }
export interface WorkerCancelAllMessage { type: 'cancelAll' }
export interface WorkerSetSpeedMessage { type: 'setSpeed'; speed: number }

export interface WorkerSetVoiceMessage {
  type: 'setVoice';
  baseUrl: string;
  voiceStylePath: string;
}

export interface WorkerSynthesizeStreamingMessage {
  type: 'synthesizeStreaming';
  id: string;
  text: string;
  speed: number;
  totalSteps: number;
  chunkDurationMs: number;
  preprocessedText?: string;
}

export interface WorkerPredictDurationMessage {
  type: 'predictDuration';
  id: string;
  text: string;
  speed: number;
  preprocessedText?: string;
}

export type WorkerInMessage =
  | WorkerInitMessage
  | WorkerSynthesizeMessage
  | WorkerCancelMessage
  | WorkerCancelAllMessage
  | WorkerSetVoiceMessage
  | WorkerSetSpeedMessage
  | WorkerSynthesizeStreamingMessage
  | WorkerPredictDurationMessage;

export interface WorkerReadyResponse { type: 'ready'; backend: 'webgpu' | 'wasm' }
export interface WorkerProgressResponse { type: 'progress'; id: string; step: number; totalSteps: number }
export interface WorkerCancelledResponse { type: 'cancelled'; id: string }
export interface WorkerErrorResponse { type: 'error'; id?: string; message: string }
export interface WorkerLoadingResponse { type: 'loading'; modelName: string; current: number; total: number }

export interface WorkerCompleteResponse {
  type: 'complete';
  id: string;
  wav: Float32Array;
  wavBuffer: ArrayBuffer;
  duration: number;
  sampleRate: number;
  wordTimestamps: WordTimestamp[];
}

export interface WorkerChunkResponse {
  type: 'chunk';
  id: string;
  audio: Float32Array;
  chunkIndex: number;
  isLast: boolean;
  sampleRate: number;
}

export interface WorkerDurationResponse {
  type: 'duration';
  id: string;
  duration: number;
  sampleRate: number;
  wordTimestamps: WordTimestamp[];
}

export interface WorkerVoiceChangedResponse {
  type: 'voiceChanged';
  voiceStylePath: string;
}

export type WorkerOutMessage =
  | WorkerReadyResponse
  | WorkerProgressResponse
  | WorkerCompleteResponse
  | WorkerCancelledResponse
  | WorkerErrorResponse
  | WorkerLoadingResponse
  | WorkerChunkResponse
  | WorkerDurationResponse
  | WorkerVoiceChangedResponse;

interface InflectConfig {
  data: { add_blank: boolean; hop_length: number; sampling_rate: number };
  deployment_frontend?: { language?: string };
  model: { inter_channels: number };
}

interface ChunkInference {
  waveform: Float32Array;
  duration: number;
}

const SHORT_WORDS = new Set([
  'a', 'an', 'the', 'is', 'am', 'are', 'was', 'were', 'be', 'been',
  'do', 'did', 'has', 'had', 'he', 'she', 'it', 'we', 'me', 'my',
  'of', 'to', 'in', 'on', 'at', 'by', 'or', 'and', 'but', 'if',
  'so', 'no', 'not', 'up', 'as', 'for', 'its', 'his', 'her', 'our',
]);
const SENTENCE_END_CHARS = new Set(['.', '!', '?']);
const PAUSE_CHARS = new Set([',', ';', ':']);
const NON_ALPHA_PATTERN = /[^a-zA-Z]/g;
const VOWEL_CLUSTERS_PATTERN = /[aeiouy]+/gi;
const VOWELS_PATTERN = /[aeiouy]/gi;
const WORD_SPLIT_PATTERN = /\s+/;
const NOISE_SCALE = 0.667;

let workerBaseUrl = '';
let currentModelPath = '';
let config: InflectConfig | null = null;
let inventory: InflectSymbolInventory | null = null;
let durationSession: ort.InferenceSession | null = null;
let decodeSession: ort.InferenceSession | null = null;
let sampleRate = 24_000;
const cancelledRequests = new Set<string>();
let currentRequestId: string | null = null;

class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

const inferenceMutex = new Mutex();

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function float32ToWav(audioData: Float32Array, rate: number): ArrayBuffer {
  const dataSize = audioData.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const output = new Int16Array(buffer, 44);
  for (let index = 0; index < audioData.length; index++) {
    output[index] = Math.round(Math.max(-1, Math.min(1, audioData[index])) * 32767);
  }
  return buffer;
}

function estimateWordWeight(word: string): number {
  const clean = word.replace(NON_ALPHA_PATTERN, '').toLowerCase();
  if (!clean) return 0.5;
  const syllables = Math.max(clean.match(VOWEL_CLUSTERS_PATTERN)?.length ?? 0, 1);
  const consonants = clean.replace(VOWELS_PATTERN, '').length;
  const weight = syllables + consonants * 0.3;
  return SHORT_WORDS.has(clean) ? weight * 0.7 : weight;
}

function heuristicWordTiming(text: string, totalDuration: number): WordTimestamp[] {
  const words = text.split(WORD_SPLIT_PATTERN).filter(Boolean);
  if (words.length === 0) return [];
  const weights = new Array<number>(words.length);
  let totalWeight = 0;
  for (let index = 0; index < words.length; index++) {
    let weight = estimateWordWeight(words[index]);
    const ending = words[index].slice(-1);
    if (SENTENCE_END_CHARS.has(ending)) weight += 0.2;
    else if (PAUSE_CHARS.has(ending)) weight += 0.1;
    weights[index] = weight;
    totalWeight += weight;
  }
  const result: WordTimestamp[] = [];
  let cursor = 0;
  for (let index = 0; index < words.length; index++) {
    const duration = totalDuration * (weights[index] / totalWeight);
    result.push({ text: words[index], start: cursor, end: cursor + duration });
    cursor += duration;
  }
  return result;
}

function createSeededRandom(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussianNoise(length: number, seed: number): Float32Array {
  const random = createSeededRandom(seed);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 2) {
    const first = Math.max(Number.EPSILON, random());
    const second = random();
    const magnitude = Math.sqrt(-2 * Math.log(first));
    output[index] = magnitude * Math.cos(2 * Math.PI * second);
    if (index + 1 < length) output[index + 1] = magnitude * Math.sin(2 * Math.PI * second);
  }
  return output;
}

function concatenate(parts: Float32Array[]): Float32Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function createTokens(text: string): Promise<BigInt64Array> {
  if (!config || !inventory) throw new Error('Inflect model metadata is not loaded');
  const phonemes = await phonemizeInflectText(text, config.deployment_frontend?.language ?? 'en-us');
  return phonemesToTokenIds(phonemes, inventory, config.data.add_blank);
}

async function inferDuration(text: string, speed: number): Promise<{
  outputs: ort.InferenceSession.OnnxValueMapType;
  inputs: ort.Tensor[];
  frames: number;
}> {
  if (!durationSession) throw new Error('Inflect duration model is not loaded');
  const tokenData = await createTokens(text);
  const tokens = new ort.Tensor('int64', tokenData, [1, tokenData.length]);
  const lengths = new ort.Tensor('int64', BigInt64Array.of(BigInt(tokenData.length)), [1]);
  const lengthScale = new ort.Tensor('float32', Float32Array.of(1 / Math.max(0.5, Math.min(2, speed))), []);
  const outputs = await durationSession.run({ tokens, lengths, length_scale: lengthScale });
  return { outputs, inputs: [tokens, lengths, lengthScale], frames: outputs.y_mask.dims[2] };
}

function disposeValues(values: Iterable<ort.Tensor | ort.OnnxValue>): void {
  for (const value of values) value.dispose?.();
}

async function inferChunk(text: string, speed: number, seed: number): Promise<ChunkInference> {
  if (!decodeSession) throw new Error('Inflect decode model is not loaded');
  const duration = await inferDuration(text, speed);
  const noiseShape = duration.outputs.m_p_exp.dims;
  const noiseLength = noiseShape.reduce((product, value) => product * value, 1);
  const noise = new ort.Tensor('float32', gaussianNoise(noiseLength, seed), noiseShape);
  const noiseScale = new ort.Tensor('float32', Float32Array.of(NOISE_SCALE), []);

  try {
    const decoded = await decodeSession.run({
      m_p_exp: duration.outputs.m_p_exp,
      logs_p_exp: duration.outputs.logs_p_exp,
      y_mask: duration.outputs.y_mask,
      zp_noise: noise,
      noise_scale: noiseScale,
    });
    try {
      const waveform = new Float32Array(decoded.waveform.data as Float32Array);
      for (let index = 0; index < waveform.length; index++) {
        waveform[index] = Math.max(-1, Math.min(1, waveform[index]));
      }
      applyEdgeFade(waveform, sampleRate);
      return { waveform, duration: waveform.length / sampleRate };
    } finally {
      disposeValues(Object.values(decoded));
    }
  } finally {
    disposeValues(duration.inputs);
    disposeValues(Object.values(duration.outputs));
    noise.dispose?.();
    noiseScale.dispose?.();
  }
}

async function synthesize(text: string, speed: number, requestId: string): Promise<ChunkInference | null> {
  const chunks = splitInflectText(text);
  const parts: Float32Array[] = [];
  for (let index = 0; index < chunks.length; index++) {
    if (cancelledRequests.has(requestId)) return null;
    if (index > 0) {
      parts.push(new Float32Array(Math.round(sampleRate * boundaryPauseSeconds(chunks[index - 1]))));
    }
    self.postMessage({ type: 'progress', id: requestId, step: index * 2 + 1, totalSteps: chunks.length * 2 } as WorkerProgressResponse);
    parts.push((await inferChunk(chunks[index], speed, index)).waveform);
    self.postMessage({ type: 'progress', id: requestId, step: index * 2 + 2, totalSteps: chunks.length * 2 } as WorkerProgressResponse);
  }
  const waveform = concatenate(parts);
  return { waveform, duration: waveform.length / sampleRate };
}

async function synthesizeStreaming(text: string, speed: number, requestId: string): Promise<void> {
  const chunks = splitInflectText(text);
  for (let index = 0; index < chunks.length; index++) {
    if (cancelledRequests.has(requestId)) return;
    const chunk = await inferChunk(chunks[index], speed, index);
    const pause = index > 0
      ? new Float32Array(Math.round(sampleRate * boundaryPauseSeconds(chunks[index - 1])))
      : null;
    const audio = pause ? concatenate([pause, chunk.waveform]) : chunk.waveform;
    self.postMessage({
      type: 'chunk', id: requestId, audio, chunkIndex: index,
      isLast: index === chunks.length - 1, sampleRate,
    } as WorkerChunkResponse, { transfer: [audio.buffer] });
  }
}

async function predictDuration(text: string, speed: number): Promise<number> {
  if (!config) throw new Error('Inflect model is not loaded');
  const chunks = splitInflectText(text);
  let durationSeconds = 0;
  for (let index = 0; index < chunks.length; index++) {
    const duration = await inferDuration(chunks[index], speed);
    durationSeconds += duration.frames * config.data.hop_length / sampleRate;
    if (index > 0) durationSeconds += boundaryPauseSeconds(chunks[index - 1]);
    disposeValues(duration.inputs);
    disposeValues(Object.values(duration.outputs));
  }
  return durationSeconds;
}

async function loadModel(baseUrl: string, modelPath: string): Promise<void> {
  await inferenceMutex.acquire();
  try {
    durationSession?.release();
    decodeSession?.release();
    durationSession = null;
    decodeSession = null;
    self.postMessage({ type: 'loading', modelName: 'Sky v3 metadata', current: 0, total: 3 } as WorkerLoadingResponse);
    const [nextConfig, nextInventory] = await Promise.all([
      fetchJson<InflectConfig>(`${baseUrl}${modelPath}/config.json`),
      fetchJson<InflectSymbolInventory>(`${baseUrl}${modelPath}/symbols.json`),
    ]);
    if (nextInventory.count !== nextInventory.symbols.length) {
      throw new Error('Sky v3 symbol inventory is invalid');
    }
    sampleRate = nextConfig.data.sampling_rate;
    config = nextConfig;
    inventory = nextInventory;

    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    };
    self.postMessage({ type: 'loading', modelName: 'Sky v3 duration model', current: 1, total: 3 } as WorkerLoadingResponse);
    const durationPromise = ort.InferenceSession.create(`${baseUrl}${modelPath}/onnx/duration.onnx`, options);
    self.postMessage({ type: 'loading', modelName: 'Sky v3 decoder', current: 2, total: 3 } as WorkerLoadingResponse);
    const decodePromise = ort.InferenceSession.create(`${baseUrl}${modelPath}/onnx/decode.onnx`, options);
    [durationSession, decodeSession] = await Promise.all([durationPromise, decodePromise]);
    currentModelPath = modelPath;
    self.postMessage({ type: 'loading', modelName: 'Sky v3 ready', current: 3, total: 3 } as WorkerLoadingResponse);
  } finally {
    inferenceMutex.release();
  }
}

async function initialize(baseUrl: string, modelPath: string, numThreads: number): Promise<'wasm'> {
  workerBaseUrl = baseUrl;
  ort.env.wasm.wasmPaths = `${baseUrl}/onnx/`;
  ort.env.wasm.numThreads = numThreads;
  await Promise.all([loadModel(baseUrl, modelPath), phonemizeInflectText('Ready.', 'en-us')]);
  return 'wasm';
}

async function runSynthesisMessage(message: WorkerSynthesizeMessage): Promise<void> {
  currentRequestId = message.id;
  await inferenceMutex.acquire();
  try {
    const result = await synthesize(message.text, message.speed, message.id);
    if (!result) {
      self.postMessage({ type: 'cancelled', id: message.id } as WorkerCancelledResponse);
      return;
    }
    const wavBuffer = float32ToWav(result.waveform, sampleRate);
    self.postMessage({
      type: 'complete', id: message.id, wav: result.waveform, wavBuffer,
      duration: result.duration, sampleRate,
      wordTimestamps: heuristicWordTiming(message.text, result.duration),
    } as WorkerCompleteResponse, { transfer: [result.waveform.buffer, wavBuffer] });
  } finally {
    inferenceMutex.release();
    currentRequestId = null;
    cancelledRequests.delete(message.id);
  }
}

async function runStreamingMessage(message: WorkerSynthesizeStreamingMessage): Promise<void> {
  currentRequestId = message.id;
  await inferenceMutex.acquire();
  try {
    await synthesizeStreaming(message.text, message.speed, message.id);
    if (cancelledRequests.has(message.id)) {
      self.postMessage({ type: 'cancelled', id: message.id } as WorkerCancelledResponse);
    }
  } finally {
    inferenceMutex.release();
    currentRequestId = null;
    cancelledRequests.delete(message.id);
  }
}

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init': {
        const backend = await initialize(message.baseUrl, message.voiceStylePath, message.numThreads ?? 4);
        self.postMessage({ type: 'ready', backend } as WorkerReadyResponse);
        break;
      }
      case 'synthesize':
        await runSynthesisMessage(message);
        break;
      case 'synthesizeStreaming':
        await runStreamingMessage(message);
        break;
      case 'predictDuration': {
        await inferenceMutex.acquire();
        try {
          const duration = await predictDuration(message.text, message.speed);
          self.postMessage({
            type: 'duration', id: message.id, duration, sampleRate,
            wordTimestamps: heuristicWordTiming(message.text, duration),
          } as WorkerDurationResponse);
        } finally {
          inferenceMutex.release();
        }
        break;
      }
      case 'setVoice':
        if (message.voiceStylePath !== currentModelPath) {
          await loadModel(message.baseUrl || workerBaseUrl, message.voiceStylePath);
        }
        self.postMessage({ type: 'voiceChanged', voiceStylePath: message.voiceStylePath } as WorkerVoiceChangedResponse);
        break;
      case 'cancel':
        cancelledRequests.add(message.id);
        break;
      case 'cancelAll':
        if (currentRequestId) cancelledRequests.add(currentRequestId);
        break;
      case 'setSpeed':
        break;
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: 'id' in message ? message.id : undefined,
      message: error instanceof Error ? error.message : 'Inflect worker operation failed',
    } as WorkerErrorResponse);
  }
};
