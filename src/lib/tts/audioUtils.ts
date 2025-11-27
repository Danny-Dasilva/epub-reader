/**
 * Write WAV file to ArrayBuffer
 */
export function writeWavFile(audioData: number[], sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = audioData.length * 2;

  // Create ArrayBuffer
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

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

  // Write audio data
  const int16Data = new Int16Array(audioData.length);
  for (let i = 0; i < audioData.length; i++) {
    const clamped = Math.max(-1.0, Math.min(1.0, audioData[i]));
    int16Data[i] = Math.floor(clamped * 32767);
  }

  const dataView = new Uint8Array(buffer, 44);
  dataView.set(new Uint8Array(int16Data.buffer));

  return buffer;
}

/**
 * Convert WAV ArrayBuffer to AudioBuffer
 */
export async function wavToAudioBuffer(
  wavBuffer: ArrayBuffer,
  audioContext: AudioContext
): Promise<AudioBuffer> {
  return await audioContext.decodeAudioData(wavBuffer);
}

/**
 * Convert Float32Array to WAV ArrayBuffer
 */
export function float32ToWav(audioData: Float32Array, sampleRate: number): ArrayBuffer {
  return writeWavFile(Array.from(audioData), sampleRate);
}

/**
 * Resample audio from one sample rate to another
 * Used for Parakeet which requires 16kHz input
 */
export function resampleAudio(
  audioData: Float32Array,
  fromSampleRate: number,
  toSampleRate: number
): Float32Array {
  if (fromSampleRate === toSampleRate) {
    return audioData;
  }

  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.floor(audioData.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, audioData.length - 1);
    const fraction = srcIndex - srcIndexFloor;

    // Linear interpolation
    result[i] = audioData[srcIndexFloor] * (1 - fraction) + audioData[srcIndexCeil] * fraction;
  }

  return result;
}

/**
 * Create a Blob URL for audio playback
 */
export function createAudioBlobUrl(wavBuffer: ArrayBuffer): string {
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}
