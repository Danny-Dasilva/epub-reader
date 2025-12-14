/**
 * TTS Web Worker
 * Runs ONNX inference in a separate thread to avoid blocking the main thread.
 * Supports cancellation between denoising steps.
 */

import * as ort from 'onnxruntime-web';
import { preprocessText } from './textPreprocessor';

// Worker message types
export interface WorkerInitMessage {
  type: 'init';
  baseUrl: string;  // e.g., 'http://localhost:3000'
  onnxDir: string;
  voiceStylePath: string;
}

export interface WorkerSynthesizeMessage {
  type: 'synthesize';
  id: string;
  text: string;
  speed: number;
  totalSteps: number;
  preprocessedText?: string;  // Optional: precomputed preprocessed text to skip preprocessing
}

export interface WorkerCancelMessage {
  type: 'cancel';
  id: string;
}

export interface WorkerCancelAllMessage {
  type: 'cancelAll';
}

export interface WorkerSetVoiceMessage {
  type: 'setVoice';
  baseUrl: string;
  voiceStylePath: string;
}

export interface WorkerSetSpeedMessage {
  type: 'setSpeed';
  speed: number;
}

export type WorkerInMessage =
  | WorkerInitMessage
  | WorkerSynthesizeMessage
  | WorkerCancelMessage
  | WorkerCancelAllMessage
  | WorkerSetVoiceMessage
  | WorkerSetSpeedMessage;

export interface WorkerReadyResponse {
  type: 'ready';
  backend: 'webgpu' | 'wasm';
}

export interface WorkerProgressResponse {
  type: 'progress';
  id: string;
  step: number;
  totalSteps: number;
}

export interface WorkerCompleteResponse {
  type: 'complete';
  id: string;
  wav: Float32Array;
  duration: number;
  sampleRate: number;
}

export interface WorkerCancelledResponse {
  type: 'cancelled';
  id: string;
}

export interface WorkerErrorResponse {
  type: 'error';
  id?: string;
  message: string;
}

export interface WorkerLoadingResponse {
  type: 'loading';
  modelName: string;
  current: number;
  total: number;
}

export type WorkerOutMessage =
  | WorkerReadyResponse
  | WorkerProgressResponse
  | WorkerCompleteResponse
  | WorkerCancelledResponse
  | WorkerErrorResponse
  | WorkerLoadingResponse;

// Worker state
let workerBaseUrl: string = '';
let ttsConfig: any = null;
let textProcessor: any = null;
let dpSession: ort.InferenceSession | null = null;
let textEncSession: ort.InferenceSession | null = null;
let vectorEstSession: ort.InferenceSession | null = null;
let vocoderSession: ort.InferenceSession | null = null;
let voiceStyle: { ttl: ort.Tensor; dp: ort.Tensor } | null = null;
let sampleRate: number = 44100;
let cancelledRequests: Set<string> = new Set();
let isProcessing = false;
let currentRequestId: string | null = null;

/**
 * Load JSON configuration
 */
async function loadConfig(baseUrl: string, onnxDir: string): Promise<any> {
  const response = await fetch(`${baseUrl}${onnxDir}/tts.json`);
  return await response.json();
}

/**
 * Load text processor indexer
 */
async function loadTextProcessor(baseUrl: string, onnxDir: string): Promise<number[]> {
  const response = await fetch(`${baseUrl}${onnxDir}/unicode_indexer.json`);
  return await response.json();
}

/**
 * Load voice style
 */
async function loadVoiceStyle(baseUrl: string, voiceStylePath: string): Promise<{ ttl: ort.Tensor; dp: ort.Tensor }> {
  const response = await fetch(`${baseUrl}${voiceStylePath}`);
  const data = await response.json();

  const ttlData = new Float32Array(data.style_ttl.data.flat(Infinity));
  const dpData = new Float32Array(data.style_dp.data.flat(Infinity));

  return {
    ttl: new ort.Tensor('float32', ttlData, data.style_ttl.dims),
    dp: new ort.Tensor('float32', dpData, data.style_dp.dims)
  };
}


/**
 * Convert text to IDs and create mask
 * @param textList - List of text strings to process
 * @param indexer - Unicode indexer for character to ID conversion
 * @param skipPreprocessing - If true, assumes text is already preprocessed (optimization)
 */
function processText(textList: string[], indexer: number[], skipPreprocessing: boolean = false): { textIds: number[][]; textMask: number[][][] } {
  const processedTexts = skipPreprocessing ? textList : textList.map(t => preprocessText(t));
  const textIdsLengths = processedTexts.map(t => t.length);
  const maxLen = Math.max(...textIdsLengths);

  const textIds = processedTexts.map(text => {
    const row = new Array(maxLen).fill(0);
    for (let j = 0; j < text.length; j++) {
      const codePoint = text.codePointAt(j);
      row[j] = codePoint !== undefined && codePoint < indexer.length
        ? indexer[codePoint]
        : -1;
    }
    return row;
  });

  const textMask = textIdsLengths.map(len => {
    const row = new Array(maxLen).fill(0.0);
    for (let j = 0; j < Math.min(len, maxLen); j++) {
      row[j] = 1.0;
    }
    return [row];
  });

  return { textIds, textMask };
}

/**
 * Chunk text into segments
 */
function chunkText(text: string, maxLen: number = 300): string[] {
  const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim());
  const chunks: string[] = [];

  for (let paragraph of paragraphs) {
    paragraph = paragraph.trim();
    if (!paragraph) continue;

    const sentences = paragraph.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/);

    let currentChunk = "";
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length + 1 <= maxLen) {
        currentChunk += (currentChunk ? " " : "") + sentence;
      } else {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = sentence;
      }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Sample noisy latent tensor
 */
function sampleNoisyLatent(
  duration: number[],
  sampleRate: number,
  baseChunkSize: number,
  chunkCompress: number,
  latentDim: number
): { xt: number[][][]; latentMask: number[][][] } {
  const bsz = duration.length;
  const maxDur = Math.max(...duration);
  const wavLenMax = Math.floor(maxDur * sampleRate);
  const wavLengths = duration.map(d => Math.floor(d * sampleRate));

  const chunkSize = baseChunkSize * chunkCompress;
  const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
  const latentDimVal = latentDim * chunkCompress;

  const xt: number[][][] = [];
  for (let b = 0; b < bsz; b++) {
    const batch: number[][] = [];
    for (let d = 0; d < latentDimVal; d++) {
      const row: number[] = [];
      for (let t = 0; t < latentLen; t++) {
        const u1 = Math.max(0.0001, Math.random());
        const u2 = Math.random();
        row.push(Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2));
      }
      batch.push(row);
    }
    xt.push(batch);
  }

  const latentLengths = wavLengths.map(len => Math.floor((len + chunkSize - 1) / chunkSize));
  const latentMask = latentLengths.map(len => {
    const row = new Array(latentLen).fill(0.0);
    for (let j = 0; j < Math.min(len, latentLen); j++) row[j] = 1.0;
    return [row];
  });

  // Apply mask
  for (let b = 0; b < bsz; b++) {
    for (let d = 0; d < latentDimVal; d++) {
      for (let t = 0; t < latentLen; t++) {
        xt[b][d][t] *= latentMask[b][0][t];
      }
    }
  }

  return { xt, latentMask };
}

/**
 * Run TTS inference with cancellation support
 */
async function synthesize(
  text: string,
  speed: number,
  totalSteps: number,
  requestId: string,
  preprocessedText?: string
): Promise<{ wav: Float32Array; duration: number } | null> {
  if (!dpSession || !textEncSession || !vectorEstSession || !vocoderSession || !voiceStyle || !textProcessor) {
    throw new Error('TTS not initialized');
  }

  // If preprocessedText is provided, use it directly (already preprocessed at parse time)
  // Otherwise, chunk the raw text (processText will handle preprocessing)
  const usePreprocessed = !!preprocessedText;
  const textToChunk = usePreprocessed ? preprocessedText : text;
  const textChunks = chunkText(textToChunk);
  let wavCat: number[] = [];
  let durCat = 0;

  for (const chunk of textChunks) {
    // Check for cancellation before each chunk
    if (cancelledRequests.has(requestId)) {
      return null;
    }

    // Skip preprocessing step if text is already preprocessed
    const { textIds, textMask } = processText([chunk], textProcessor, usePreprocessed);
    const bsz = 1;

    const textIdsTensor = new ort.Tensor(
      'int64',
      new BigInt64Array(textIds.flat().map(x => BigInt(x))),
      [bsz, textIds[0].length]
    );

    const textMaskTensor = new ort.Tensor(
      'float32',
      new Float32Array(textMask.flat(2)),
      [bsz, 1, textMask[0][0].length]
    );

    // Predict duration
    const dpOutputs = await dpSession.run({
      text_ids: textIdsTensor,
      style_dp: voiceStyle.dp,
      text_mask: textMaskTensor
    });
    const duration = Array.from(dpOutputs.duration.data as Float32Array);

    // Dispose duration output tensor to free memory
    dpOutputs.duration.dispose?.();
    for (let i = 0; i < duration.length; i++) {
      duration[i] /= speed;
    }

    // Encode text
    const textEncOutputs = await textEncSession.run({
      text_ids: textIdsTensor,
      style_ttl: voiceStyle.ttl,
      text_mask: textMaskTensor
    });
    const textEmb = textEncOutputs.text_emb;

    // Dispose textIdsTensor - no longer needed after text encoding
    // NOTE: textMaskTensor is still needed in the denoising loop, dispose it later
    textIdsTensor.dispose?.();

    // Sample noisy latent
    let { xt, latentMask } = sampleNoisyLatent(
      duration,
      sampleRate,
      ttsConfig.ae.base_chunk_size,
      ttsConfig.ttl.chunk_compress_factor,
      ttsConfig.ttl.latent_dim
    );

    const latentMaskTensor = new ort.Tensor(
      'float32',
      new Float32Array(latentMask.flat(2)),
      [bsz, 1, latentMask[0][0].length]
    );

    const totalStepTensor = new ort.Tensor('float32', new Float32Array([totalSteps]), [bsz]);

    // Denoising loop with cancellation checks
    for (let step = 0; step < totalSteps; step++) {
      // Check for cancellation between each denoising step
      if (cancelledRequests.has(requestId)) {
        // Dispose tensors before returning
        latentMaskTensor.dispose?.();
        totalStepTensor.dispose?.();
        textMaskTensor.dispose?.();
        textEmb.dispose?.();
        return null;
      }

      // Report progress
      self.postMessage({
        type: 'progress',
        id: requestId,
        step: step + 1,
        totalSteps
      } as WorkerProgressResponse);

      const currentStepTensor = new ort.Tensor('float32', new Float32Array([step]), [bsz]);
      const xtTensor = new ort.Tensor(
        'float32',
        new Float32Array(xt.flat(2)),
        [bsz, xt[0].length, xt[0][0].length]
      );

      const vectorEstOutputs = await vectorEstSession.run({
        noisy_latent: xtTensor,
        text_emb: textEmb,
        style_ttl: voiceStyle.ttl,
        latent_mask: latentMaskTensor,
        text_mask: textMaskTensor,
        current_step: currentStepTensor,
        total_step: totalStepTensor
      });

      const denoised = Array.from(vectorEstOutputs.denoised_latent.data as Float32Array);

      // Dispose tensors created in this iteration to prevent memory leak
      currentStepTensor.dispose?.();
      xtTensor.dispose?.();
      vectorEstOutputs.denoised_latent.dispose?.();

      // Reshape to 3D
      const latentDim = xt[0].length;
      const latentLen = xt[0][0].length;
      xt = [];
      let idx = 0;
      for (let b = 0; b < bsz; b++) {
        const batch: number[][] = [];
        for (let d = 0; d < latentDim; d++) {
          const row: number[] = [];
          for (let t = 0; t < latentLen; t++) {
            row.push(denoised[idx++]);
          }
          batch.push(row);
        }
        xt.push(batch);
      }
    }

    // Final cancellation check before vocoder
    if (cancelledRequests.has(requestId)) {
      // Dispose remaining tensors before returning
      latentMaskTensor.dispose?.();
      totalStepTensor.dispose?.();
      textMaskTensor.dispose?.();
      textEmb.dispose?.();
      return null;
    }

    // Dispose tensors used in the denoising loop (no longer needed)
    latentMaskTensor.dispose?.();
    totalStepTensor.dispose?.();
    textMaskTensor.dispose?.();
    textEmb.dispose?.();

    // Generate waveform
    const finalXtTensor = new ort.Tensor(
      'float32',
      new Float32Array(xt.flat(2)),
      [bsz, xt[0].length, xt[0][0].length]
    );

    const vocoderOutputs = await vocoderSession.run({ latent: finalXtTensor });
    const wav = Array.from(vocoderOutputs.wav_tts.data as Float32Array);

    // Dispose vocoder tensors
    finalXtTensor.dispose?.();
    vocoderOutputs.wav_tts.dispose?.();

    // Concatenate
    if (wavCat.length === 0) {
      wavCat = wav;
      durCat = duration[0];
    } else {
      const silenceLen = Math.floor(0.3 * sampleRate);
      const silence = new Array(silenceLen).fill(0);
      wavCat = [...wavCat, ...silence, ...wav];
      durCat += duration[0] + 0.3;
    }
  }

  return { wav: new Float32Array(wavCat), duration: durCat };
}

/**
 * Initialize TTS models
 */
async function initialize(baseUrl: string, onnxDir: string, voiceStylePath: string): Promise<'webgpu' | 'wasm'> {
  // Store baseUrl for later use (e.g., voice changes)
  workerBaseUrl = baseUrl;

  // Configure ONNX wasm paths with absolute URL
  ort.env.wasm.wasmPaths = `${baseUrl}/onnx/`;
  ort.env.wasm.numThreads = 4;

  self.postMessage({ type: 'loading', modelName: 'Configuration', current: 0, total: 5 } as WorkerLoadingResponse);

  ttsConfig = await loadConfig(baseUrl, onnxDir);
  sampleRate = ttsConfig.ae.sample_rate;
  textProcessor = await loadTextProcessor(baseUrl, onnxDir);

  const modelPaths = [
    { name: 'Duration Predictor', path: `${baseUrl}${onnxDir}/duration_predictor.onnx` },
    { name: 'Text Encoder', path: `${baseUrl}${onnxDir}/text_encoder.onnx` },
    { name: 'Vector Estimator', path: `${baseUrl}${onnxDir}/vector_estimator.onnx` },
    { name: 'Vocoder', path: `${baseUrl}${onnxDir}/vocoder.onnx` }
  ];

  // Try WASM backend (most reliable in workers)
  // WebGPU has known issues in Web Workers (https://github.com/microsoft/onnxruntime/issues/20876)
  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  };

  const sessions: ort.InferenceSession[] = [];
  for (let i = 0; i < modelPaths.length; i++) {
    self.postMessage({
      type: 'loading',
      modelName: modelPaths[i].name,
      current: i + 1,
      total: modelPaths.length + 1
    } as WorkerLoadingResponse);

    const session = await ort.InferenceSession.create(modelPaths[i].path, sessionOptions);
    sessions.push(session);
  }

  [dpSession, textEncSession, vectorEstSession, vocoderSession] = sessions;

  self.postMessage({ type: 'loading', modelName: 'Voice Style', current: 5, total: 5 } as WorkerLoadingResponse);
  voiceStyle = await loadVoiceStyle(baseUrl, voiceStylePath);

  return 'wasm';
}

// Message handler
self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'init': {
      try {
        const backend = await initialize(message.baseUrl, message.onnxDir, message.voiceStylePath);
        self.postMessage({ type: 'ready', backend } as WorkerReadyResponse);
      } catch (error) {
        self.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : 'Initialization failed'
        } as WorkerErrorResponse);
      }
      break;
    }

    case 'synthesize': {
      // If already processing, queue will be handled by manager
      if (isProcessing) {
        self.postMessage({
          type: 'error',
          id: message.id,
          message: 'Worker is busy'
        } as WorkerErrorResponse);
        return;
      }

      isProcessing = true;
      currentRequestId = message.id;

      try {
        const result = await synthesize(
          message.text,
          message.speed,
          message.totalSteps,
          message.id,
          message.preprocessedText
        );

        if (result === null) {
          // Was cancelled
          self.postMessage({ type: 'cancelled', id: message.id } as WorkerCancelledResponse);
        } else {
          // Transfer the Float32Array for efficiency
          self.postMessage({
            type: 'complete',
            id: message.id,
            wav: result.wav,
            duration: result.duration,
            sampleRate
          } as WorkerCompleteResponse, { transfer: [result.wav.buffer] });
        }
      } catch (error) {
        self.postMessage({
          type: 'error',
          id: message.id,
          message: error instanceof Error ? error.message : 'Synthesis failed'
        } as WorkerErrorResponse);
      } finally {
        isProcessing = false;
        currentRequestId = null;
        cancelledRequests.delete(message.id);
      }
      break;
    }

    case 'cancel': {
      cancelledRequests.add(message.id);
      break;
    }

    case 'cancelAll': {
      if (currentRequestId) {
        cancelledRequests.add(currentRequestId);
      }
      break;
    }

    case 'setVoice': {
      try {
        voiceStyle = await loadVoiceStyle(message.baseUrl, message.voiceStylePath);
      } catch (error) {
        self.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to load voice'
        } as WorkerErrorResponse);
      }
      break;
    }
  }
};
