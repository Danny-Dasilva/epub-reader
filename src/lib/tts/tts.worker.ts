/**
 * TTS Web Worker
 * Runs ONNX inference in a separate thread to avoid blocking the main thread.
 * Supports cancellation between denoising steps.
 */

import * as ort from 'onnxruntime-web';
import { preprocessText } from './textPreprocessor';
import { VoiceStyleManager } from './VoiceStyleManager';

// Worker message types
export interface WorkerInitMessage {
  type: 'init';
  baseUrl: string;  // e.g., 'http://localhost:3000'
  onnxDir: string;
  voiceStylePath: string;
  enableLazyVoiceLoading?: boolean;  // Enable lazy voice loading feature
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

export interface WorkerSynthesizeStreamingMessage {
  type: 'synthesizeStreaming';
  id: string;
  text: string;
  speed: number;
  totalSteps: number;
  chunkDurationMs: number;  // Target chunk duration in milliseconds (~500ms)
  preprocessedText?: string;
}

export type WorkerInMessage =
  | WorkerInitMessage
  | WorkerSynthesizeMessage
  | WorkerCancelMessage
  | WorkerCancelAllMessage
  | WorkerSetVoiceMessage
  | WorkerSetSpeedMessage
  | WorkerSynthesizeStreamingMessage;

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
  wavBuffer: ArrayBuffer;  // Optimization #3: Pre-encoded WAV buffer (avoids main thread encoding)
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

export interface WorkerChunkResponse {
  type: 'chunk';
  id: string;
  audio: Float32Array;
  chunkIndex: number;
  isLast: boolean;
}

export type WorkerOutMessage =
  | WorkerReadyResponse
  | WorkerProgressResponse
  | WorkerCompleteResponse
  | WorkerCancelledResponse
  | WorkerErrorResponse
  | WorkerLoadingResponse
  | WorkerChunkResponse;

/**
 * Optimization #3: WAV encoding in worker (avoids main thread blocking)
 * Converts Float32Array PCM to WAV ArrayBuffer
 */
function float32ToWav(audioData: Float32Array, sampleRate: number): ArrayBuffer {
  const dataSize = audioData.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;

  // Write WAV header
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Direct Float32 → Int16 conversion
  const int16View = new Int16Array(buffer, 44);
  for (let i = 0; i < audioData.length; i++) {
    const clamped = Math.max(-1.0, Math.min(1.0, audioData[i]));
    int16View[i] = Math.floor(clamped * 32767);
  }

  return buffer;
}

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
let voiceStyleManager: VoiceStyleManager | null = null;
let currentVoiceId: string = '';
let enableLazyVoiceLoading: boolean = false;

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
 * Extract voice ID from voice style path
 * @param voiceStylePath - Path like "/voice_styles/M1.json"
 * @returns Voice ID like "M1"
 */
function extractVoiceId(voiceStylePath: string): string {
  const match = voiceStylePath.match(/\/voice_styles\/(\w+)\.json$/);
  return match?.[1] || 'M1';
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
 * Returns a flat Float32Array for efficient tensor operations (avoids .flat() in hot loop)
 */
function sampleNoisyLatent(
  duration: number[],
  sampleRate: number,
  baseChunkSize: number,
  chunkCompress: number,
  latentDim: number
): { xt: Float32Array; latentMask: number[][][]; latentDimVal: number; latentLen: number } {
  const bsz = duration.length;
  const maxDur = Math.max(...duration);
  const wavLenMax = Math.floor(maxDur * sampleRate);
  const wavLengths = duration.map(d => Math.floor(d * sampleRate));

  const chunkSize = baseChunkSize * chunkCompress;
  const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
  const latentDimVal = latentDim * chunkCompress;

  // Pre-allocate flat Float32Array for efficiency (avoids nested array creation and .flat())
  const totalSize = bsz * latentDimVal * latentLen;
  const xt = new Float32Array(totalSize);

  // Fill with Gaussian noise directly into flat array
  for (let i = 0; i < totalSize; i++) {
    const u1 = Math.max(0.0001, Math.random());
    const u2 = Math.random();
    xt[i] = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  const latentLengths = wavLengths.map(len => Math.floor((len + chunkSize - 1) / chunkSize));
  const latentMask = latentLengths.map(len => {
    const row = new Array(latentLen).fill(0.0);
    for (let j = 0; j < Math.min(len, latentLen); j++) row[j] = 1.0;
    return [row];
  });

  // Apply mask to flat array (index: b * latentDimVal * latentLen + d * latentLen + t)
  for (let b = 0; b < bsz; b++) {
    const bOffset = b * latentDimVal * latentLen;
    for (let d = 0; d < latentDimVal; d++) {
      const dOffset = bOffset + d * latentLen;
      for (let t = 0; t < latentLen; t++) {
        xt[dOffset + t] *= latentMask[b][0][t];
      }
    }
  }

  return { xt, latentMask, latentDimVal, latentLen };
}

/**
 * Calculate chunk boundaries based on phoneme durations
 * @param durations - Array of phoneme durations in seconds
 * @param targetChunkMs - Target chunk duration in milliseconds
 * @returns Array of phoneme index ranges for each chunk
 */
function calculateChunkBoundaries(durations: number[], targetChunkMs: number): number[][] {
  const chunks: number[][] = [];
  let currentChunk: number[] = [];
  let currentDurationMs = 0;

  for (let i = 0; i < durations.length; i++) {
    const phonemeDurationMs = durations[i] * 1000;
    currentChunk.push(i);
    currentDurationMs += phonemeDurationMs;

    // Create chunk when we exceed target duration
    if (currentDurationMs >= targetChunkMs) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentDurationMs = 0;
    }
  }

  // Add remaining phonemes as final chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Synthesize text with streaming output (emits chunks as they're generated)
 * Chunks text AFTER duration prediction but BEFORE expensive diffusion steps
 */
async function synthesizeStreaming(
  text: string,
  speed: number,
  totalSteps: number,
  chunkDurationMs: number,
  requestId: string,
  preprocessedText?: string
): Promise<void> {
  if (!dpSession || !textEncSession || !vectorEstSession || !vocoderSession || !voiceStyle || !textProcessor) {
    throw new Error('TTS not initialized');
  }

  // Use preprocessed text if provided, otherwise preprocess now
  const usePreprocessed = !!preprocessedText;
  const textToProcess = usePreprocessed ? preprocessedText : text;
  const textChunks = chunkText(textToProcess);

  let globalChunkIndex = 0;

  for (const textChunk of textChunks) {
    // Check for cancellation before each text chunk
    if (cancelledRequests.has(requestId)) {
      return;
    }

    const { textIds, textMask } = processText([textChunk], textProcessor, usePreprocessed);
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

    // Step 1: Predict duration for entire text chunk (fast)
    const dpOutputs = await dpSession.run({
      text_ids: textIdsTensor,
      style_dp: voiceStyle.dp,
      text_mask: textMaskTensor
    });
    const duration = Array.from(dpOutputs.duration.data as Float32Array);
    dpOutputs.duration.dispose?.();

    // Apply speed adjustment
    for (let i = 0; i < duration.length; i++) {
      duration[i] /= speed;
    }

    // Step 2: Calculate chunk boundaries based on duration
    const phonemeChunks = calculateChunkBoundaries(duration, chunkDurationMs);

    // Step 3: Encode text once (reused for all chunks)
    const textEncOutputs = await textEncSession.run({
      text_ids: textIdsTensor,
      style_ttl: voiceStyle.ttl,
      text_mask: textMaskTensor
    });
    const textEmb = textEncOutputs.text_emb;
    textIdsTensor.dispose?.();

    // Step 4: Synthesize each chunk
    for (let chunkIdx = 0; chunkIdx < phonemeChunks.length; chunkIdx++) {
      // Check for cancellation between chunks
      if (cancelledRequests.has(requestId)) {
        textMaskTensor.dispose?.();
        textEmb.dispose?.();
        return;
      }

      const phonemeIndices = phonemeChunks[chunkIdx];
      const chunkDurations = phonemeIndices.map(i => duration[i]);

      // Sample noisy latent for this chunk
      let { xt, latentMask, latentDimVal, latentLen } = sampleNoisyLatent(
        chunkDurations,
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

      // Denoising loop for this chunk
      for (let step = 0; step < totalSteps; step++) {
        if (cancelledRequests.has(requestId)) {
          latentMaskTensor.dispose?.();
          totalStepTensor.dispose?.();
          textMaskTensor.dispose?.();
          textEmb.dispose?.();
          return;
        }

        const currentStepTensor = new ort.Tensor('float32', new Float32Array([step]), [bsz]);
        const xtTensor = new ort.Tensor('float32', xt, [bsz, latentDimVal, latentLen]);

        const vectorEstOutputs = await vectorEstSession.run({
          noisy_latent: xtTensor,
          text_emb: textEmb,
          style_ttl: voiceStyle.ttl,
          latent_mask: latentMaskTensor,
          text_mask: textMaskTensor,
          current_step: currentStepTensor,
          total_step: totalStepTensor
        });

        const denoisedData = vectorEstOutputs.denoised_latent.data as Float32Array;
        xt.set(denoisedData);

        currentStepTensor.dispose?.();
        xtTensor.dispose?.();
        vectorEstOutputs.denoised_latent.dispose?.();
      }

      // Final cancellation check before vocoder
      if (cancelledRequests.has(requestId)) {
        latentMaskTensor.dispose?.();
        totalStepTensor.dispose?.();
        textMaskTensor.dispose?.();
        textEmb.dispose?.();
        return;
      }

      // Generate waveform for this chunk
      const finalXtTensor = new ort.Tensor('float32', xt, [bsz, latentDimVal, latentLen]);
      const vocoderOutputs = await vocoderSession.run({ latent: finalXtTensor });
      const wav = new Float32Array(vocoderOutputs.wav_tts.data as Float32Array);

      finalXtTensor.dispose?.();
      vocoderOutputs.wav_tts.dispose?.();
      latentMaskTensor.dispose?.();
      totalStepTensor.dispose?.();

      // Emit chunk immediately (transferable for zero-copy)
      const isLast = (chunkIdx === phonemeChunks.length - 1) && (textChunk === textChunks[textChunks.length - 1]);
      self.postMessage({
        type: 'chunk',
        id: requestId,
        audio: wav,
        chunkIndex: globalChunkIndex++,
        isLast
      } as WorkerChunkResponse, { transfer: [wav.buffer] });
    }

    // Dispose text encoding tensors after processing all chunks for this text chunk
    textMaskTensor.dispose?.();
    textEmb.dispose?.();
  }
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
  // Collect wav chunks as Float32Arrays for efficient concatenation at the end
  const wavChunks: Float32Array[] = [];
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

    // Sample noisy latent - returns flat Float32Array for efficiency
    let { xt, latentMask, latentDimVal, latentLen } = sampleNoisyLatent(
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
    // xt is kept as flat Float32Array throughout to avoid .flat() and array reconstruction
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
      // Create tensor directly from flat array - no .flat(2) needed
      const xtTensor = new ort.Tensor(
        'float32',
        xt,
        [bsz, latentDimVal, latentLen]
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

      // Get the denoised data directly as Float32Array - no Array.from() needed
      const denoisedData = vectorEstOutputs.denoised_latent.data as Float32Array;

      // Copy to xt for next iteration (reuse the same typed array buffer)
      xt.set(denoisedData);

      // Dispose tensors created in this iteration to prevent memory leak
      currentStepTensor.dispose?.();
      xtTensor.dispose?.();
      vectorEstOutputs.denoised_latent.dispose?.();
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

    // Generate waveform - xt is already flat Float32Array
    const finalXtTensor = new ort.Tensor(
      'float32',
      xt,
      [bsz, latentDimVal, latentLen]
    );

    const vocoderOutputs = await vocoderSession.run({ latent: finalXtTensor });
    // Keep as Float32Array - avoid Array.from() conversion
    const wav = new Float32Array(vocoderOutputs.wav_tts.data as Float32Array);

    // Dispose vocoder tensors
    finalXtTensor.dispose?.();
    vocoderOutputs.wav_tts.dispose?.();

    // Collect chunks for efficient concatenation at the end
    wavChunks.push(wav);
    durCat += duration[0];
  }

  // Efficient typed array concatenation - calculate total size once, allocate once
  const silenceLen = Math.floor(0.3 * sampleRate);
  const totalLength = wavChunks.reduce((sum, chunk, i) => {
    // Add silence between chunks (not before first chunk)
    return sum + chunk.length + (i > 0 ? silenceLen : 0);
  }, 0);

  const wavCat = new Float32Array(totalLength);
  let offset = 0;
  for (let i = 0; i < wavChunks.length; i++) {
    // Add silence between chunks (not before first chunk)
    if (i > 0) {
      // Silence is already zeros in a new Float32Array, just advance offset
      offset += silenceLen;
    }
    wavCat.set(wavChunks[i], offset);
    offset += wavChunks[i].length;
  }

  // Add silence duration between chunks to total duration
  durCat += (wavChunks.length - 1) * 0.3;

  return { wav: wavCat, duration: durCat };
}

/**
 * Initialize TTS models
 */
async function initialize(baseUrl: string, onnxDir: string, voiceStylePath: string, useLazyLoading: boolean = false): Promise<'webgpu' | 'wasm'> {
  // Store baseUrl for later use (e.g., voice changes)
  workerBaseUrl = baseUrl;
  enableLazyVoiceLoading = useLazyLoading;

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

  // Use VoiceStyleManager if lazy loading is enabled
  if (enableLazyVoiceLoading) {
    voiceStyleManager = new VoiceStyleManager();
    voiceStyleManager.setBaseUrl(baseUrl);

    currentVoiceId = extractVoiceId(voiceStylePath);
    voiceStyle = await voiceStyleManager.loadStyle(currentVoiceId);
  } else {
    // Legacy mode: load voice style directly
    voiceStyle = await loadVoiceStyle(baseUrl, voiceStylePath);
    currentVoiceId = extractVoiceId(voiceStylePath);
  }

  return 'wasm';
}

// Message handler
self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'init': {
      try {
        const useLazyLoading = message.enableLazyVoiceLoading ?? false;
        const backend = await initialize(message.baseUrl, message.onnxDir, message.voiceStylePath, useLazyLoading);
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
          // Optimization #3: Encode WAV in worker to avoid main thread blocking
          const wavBuffer = float32ToWav(result.wav, sampleRate);

          // Transfer both buffers for efficiency (zero-copy transfer)
          self.postMessage({
            type: 'complete',
            id: message.id,
            wav: result.wav,
            wavBuffer,
            duration: result.duration,
            sampleRate
          } as WorkerCompleteResponse, { transfer: [result.wav.buffer, wavBuffer] });
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

    case 'synthesizeStreaming': {
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
        await synthesizeStreaming(
          message.text,
          message.speed,
          message.totalSteps,
          message.chunkDurationMs,
          message.id,
          message.preprocessedText
        );

        // Check if cancelled
        if (cancelledRequests.has(message.id)) {
          self.postMessage({ type: 'cancelled', id: message.id } as WorkerCancelledResponse);
        }
      } catch (error) {
        self.postMessage({
          type: 'error',
          id: message.id,
          message: error instanceof Error ? error.message : 'Streaming synthesis failed'
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
        const newVoiceId = extractVoiceId(message.voiceStylePath);

        // Use VoiceStyleManager if lazy loading is enabled
        if (enableLazyVoiceLoading && voiceStyleManager) {
          const isCached = voiceStyleManager.isCached(newVoiceId);
          if (isCached) {
            console.log(`[Worker] Voice ${newVoiceId} already cached, instant switch`);
          }

          voiceStyle = await voiceStyleManager.loadStyle(newVoiceId);
          currentVoiceId = newVoiceId;
        } else {
          // Legacy mode: load voice style directly
          voiceStyle = await loadVoiceStyle(message.baseUrl, message.voiceStylePath);
          currentVoiceId = newVoiceId;
        }
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
