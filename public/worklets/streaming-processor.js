/**
 * Streaming Audio Worklet Processor
 * Buffers incoming audio chunks and streams them to the audio output
 * with automatic playback start after reaching a threshold
 */

class StreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Ring buffer for audio samples (10 second capacity)
    this.buffer = new Float32Array(44100 * 10);
    this.writePos = 0;
    this.readPos = 0;
    this.isStarted = false;

    // Start playback after 500ms of audio is buffered
    this.startThreshold = 44100 * 0.5;
    this.isComplete = false;

    // Handle messages from main thread
    this.port.onmessage = (e) => {
      if (e.data.type === 'chunk') {
        this.appendChunk(e.data.audio);
      } else if (e.data.type === 'complete') {
        this.isComplete = true;
      } else if (e.data.type === 'reset') {
        this.reset();
      }
    };
  }

  appendChunk(chunk) {
    // Expand buffer if needed (double the size)
    if (this.writePos + chunk.length > this.buffer.length) {
      const newBuffer = new Float32Array(this.buffer.length * 2);
      newBuffer.set(this.buffer);
      this.buffer = newBuffer;
    }

    // Append chunk to buffer
    this.buffer.set(chunk, this.writePos);
    this.writePos += chunk.length;

    // Auto-start playback when threshold is reached
    if (!this.isStarted && (this.writePos - this.readPos) >= this.startThreshold) {
      this.isStarted = true;
      this.port.postMessage({ type: 'started' });
    }
  }

  reset() {
    this.writePos = 0;
    this.readPos = 0;
    this.isStarted = false;
    this.isComplete = false;
  }

  process(inputs, outputs) {
    const output = outputs[0][0];

    if (!output) {
      return true;
    }

    // Fill with silence until playback starts
    if (!this.isStarted) {
      output.fill(0);
      return true;
    }

    // Stream audio from buffer
    for (let i = 0; i < output.length; i++) {
      if (this.readPos < this.writePos) {
        output[i] = this.buffer[this.readPos++];
      } else {
        // Buffer underrun - fill with silence
        output[i] = 0;
      }
    }

    // Report progress and completion
    if (this.isComplete && this.readPos >= this.writePos) {
      this.port.postMessage({ type: 'ended' });
    } else {
      const progress = this.writePos > 0 ? this.readPos / this.writePos : 0;
      this.port.postMessage({
        type: 'progress',
        progress,
        readPos: this.readPos,
        writePos: this.writePos
      });
    }

    return true;
  }
}

registerProcessor('streaming-processor', StreamingProcessor);
