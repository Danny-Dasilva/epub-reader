import * as ort from 'onnxruntime-web';
import { UnicodeProcessor } from './UnicodeProcessor';
import { TextToSpeech } from './TextToSpeech';
import { TTSConfig, Style, LoadProgressCallback } from './types';

// Configure ONNX runtime environment for WebGPU
// Set WASM paths to public directory for proper loading
if (typeof window !== 'undefined') {
  ort.env.wasm.wasmPaths = '/onnx/';
  ort.env.wasm.numThreads = 4;
}

/**
 * Load configuration from JSON
 */
export async function loadConfig(onnxDir: string): Promise<TTSConfig> {
  const response = await fetch(`${onnxDir}/tts.json`);
  const cfgs = await response.json();
  return cfgs;
}

/**
 * Load text processor
 */
export async function loadTextProcessor(onnxDir: string): Promise<UnicodeProcessor> {
  const response = await fetch(`${onnxDir}/unicode_indexer.json`);
  const indexer = await response.json();
  return new UnicodeProcessor(indexer);
}

/**
 * Load ONNX model
 */
export async function loadOnnx(
  onnxPath: string,
  options: ort.InferenceSession.SessionOptions
): Promise<ort.InferenceSession> {
  const session = await ort.InferenceSession.create(onnxPath, options);
  return session;
}

/**
 * Load voice style from JSON file
 */
export async function loadVoiceStyle(voiceStylePath: string): Promise<Style> {
  const response = await fetch(voiceStylePath);
  const voiceStyle = await response.json();

  const ttlDims = voiceStyle.style_ttl.dims;
  const dpDims = voiceStyle.style_dp.dims;

  const ttlData = new Float32Array(voiceStyle.style_ttl.data.flat(Infinity));
  const dpData = new Float32Array(voiceStyle.style_dp.data.flat(Infinity));

  const ttlTensor = new ort.Tensor('float32', ttlData, ttlDims);
  const dpTensor = new ort.Tensor('float32', dpData, dpDims);

  return new Style(ttlTensor, dpTensor);
}

/**
 * Load all TTS components
 */
export async function loadTextToSpeech(
  onnxDir: string,
  sessionOptions: ort.InferenceSession.SessionOptions = {},
  progressCallback: LoadProgressCallback | null = null
): Promise<{ textToSpeech: TextToSpeech; cfgs: TTSConfig }> {
  console.log('Loading TTS models...');

  const cfgs = await loadConfig(onnxDir);

  const modelPaths = [
    { name: 'Duration Predictor', path: `${onnxDir}/duration_predictor.onnx` },
    { name: 'Text Encoder', path: `${onnxDir}/text_encoder.onnx` },
    { name: 'Vector Estimator', path: `${onnxDir}/vector_estimator.onnx` },
    { name: 'Vocoder', path: `${onnxDir}/vocoder.onnx` }
  ];

  const sessions: ort.InferenceSession[] = [];
  for (let i = 0; i < modelPaths.length; i++) {
    if (progressCallback) {
      progressCallback(modelPaths[i].name, i + 1, modelPaths.length);
    }
    console.log(`Loading ${modelPaths[i].name}...`);
    const session = await loadOnnx(modelPaths[i].path, sessionOptions);
    sessions.push(session);
  }

  const [dpOrt, textEncOrt, vectorEstOrt, vocoderOrt] = sessions;

  const textProcessor = await loadTextProcessor(onnxDir);
  const textToSpeech = new TextToSpeech(
    cfgs,
    textProcessor,
    dpOrt,
    textEncOrt,
    vectorEstOrt,
    vocoderOrt
  );

  console.log('TTS models loaded successfully');
  return { textToSpeech, cfgs };
}

/**
 * Initialize TTS with WebGPU, falling back to WASM if needed
 */
export async function initializeTTS(
  onnxDir: string,
  progressCallback: LoadProgressCallback | null = null
): Promise<{ textToSpeech: TextToSpeech; cfgs: TTSConfig; backend: 'webgpu' | 'wasm' }> {
  // Try WebGPU first
  try {
    console.log('Attempting WebGPU backend...');
    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all'
    };
    const result = await loadTextToSpeech(onnxDir, sessionOptions, progressCallback);
    console.log('Using WebGPU backend');
    return { ...result, backend: 'webgpu' };
  } catch (webgpuError) {
    console.warn('WebGPU not available, falling back to WASM:', webgpuError);
  }

  // Fallback to WASM
  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  };
  const result = await loadTextToSpeech(onnxDir, sessionOptions, progressCallback);
  console.log('Using WASM backend');
  return { ...result, backend: 'wasm' };
}
