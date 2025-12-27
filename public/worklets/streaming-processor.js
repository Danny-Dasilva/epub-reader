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
    this.isPaused = false;

    // Start playback after 500ms of audio is buffered
    this.startThreshold = 44100 * 0.5;
    this.isComplete = false;
    this.hasEnded = false;  // Guard to send 'ended' only once

    // Handle messages from main thread
    this.port.onmessage = (e) => {
      if (e.data.type === 'chunk') {
        this.appendChunk(e.data.audio);
      } else if (e.data.type === 'complete') {
        this.isComplete = true;
      } else if (e.data.type === 'reset') {
        this.reset();
      } else if (e.data.type === 'pause') {
        this.isPaused = true;
      } else if (e.data.type === 'resume') {
        this.isPaused = false;
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
    this.hasEnded = false;  // Reset the ended guard for new sentence
    this.isPaused = false;
  }

  process(inputs, outputs) {
    const output = outputs[0][0];

    if (!output) {
      return true;
    }

    // Fill with silence until playback starts or when paused
    if (!this.isStarted || this.isPaused) {
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

    // Report progress and completion (only when not paused)
    // CRITICAL: Only send 'ended' ONCE to prevent duplicate sentenceEnd events
    if (this.isComplete && this.readPos >= this.writePos && !this.hasEnded) {
      this.hasEnded = true;
      this.port.postMessage({ type: 'ended' });
    } else if (!this.hasEnded) {
      // Only send progress while still playing (not after ended)
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
