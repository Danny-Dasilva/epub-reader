/**
 * Streaming Audio Worklet Processor
 * Buffers incoming audio chunks and streams them to the audio output
 * with automatic playback start after reaching a threshold
 */

class StreamingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Ring buffer for audio samples (10 second capacity)
    this.initialBufferSize = 44100 * 10;
    this.buffer = new Float32Array(this.initialBufferSize);
    this.writePos = 0;
    this.readPos = 0;  // Now a float for fractional positioning (playback rate)
    this.isStarted = false;
    this.isPaused = false;

    // Playback rate support (1.0 = normal, 2.0 = double speed)
    // Read initial rate from processorOptions to prevent race condition
    // where process() runs before setPlaybackRate message is received
    this.playbackRate = options?.processorOptions?.initialPlaybackRate ?? 1.0;
    // Track samples consumed for accurate time reporting
    this.samplesConsumed = 0;

    // Performance optimization #1: Throttle progress messages to 30Hz
    // Reduces cross-thread serialization from 344Hz to 30Hz
    this.lastProgressTime = 0;
    this.progressThrottleMs = 33; // ~30Hz

    // Start playback after 500ms of audio is buffered
    this.startThreshold = 44100 * 0.5;
    this.isComplete = false;
    this.hasEnded = false;  // Guard to send 'ended' only once

    // FIX #4: Generation counter to ignore stale chunks after reset
    this.generation = 0;

    // Handle messages from main thread
    this.port.onmessage = (e) => {
      // FIX #4 (P1-6): Validate generation for ALL messages except reset
      if (e.data.type !== 'reset' &&
          e.data.generation !== undefined &&
          e.data.generation !== this.generation) {
        return; // Silently drop stale message
      }

      if (e.data.type === 'chunk') {
        this.appendChunk(e.data.audio);
      } else if (e.data.type === 'complete') {
        this.isComplete = true;
      } else if (e.data.type === 'reset') {
        // FIX #4: Store new generation from reset message
        if (e.data.generation !== undefined) {
          this.generation = e.data.generation;
        }
        this.reset(e.data.playbackRate);
      } else if (e.data.type === 'pause') {
        this.isPaused = true;
      } else if (e.data.type === 'resume') {
        this.isPaused = false;
      } else if (e.data.type === 'setPlaybackRate') {
        this.playbackRate = Math.max(0.5, Math.min(2.0, e.data.rate));
      } else if (e.data.type === 'preallocate') {
        // Performance optimization #10: Pre-allocate buffer based on estimated duration
        this.preallocateBuffer(e.data.estimatedSamples);
      }
    };
  }

  /**
   * Performance optimization #10: Pre-allocate buffer for expected sentence length
   * Reduces dynamic reallocations during streaming
   */
  preallocateBuffer(estimatedSamples) {
    // Add 20% headroom for safety
    const targetSize = Math.ceil(estimatedSamples * 1.2);

    // Only reallocate if we need more space
    if (targetSize > this.buffer.length) {
      const newBuffer = new Float32Array(targetSize);
      // Copy existing data if any
      if (this.writePos > 0) {
        newBuffer.set(this.buffer.subarray(0, this.writePos));
      }
      this.buffer = newBuffer;
    }
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

  reset(playbackRate = null) {
    // Compact buffer back to initial size if it grew (Fix #3: memory leak)
    if (this.buffer.length > this.initialBufferSize) {
      this.buffer = new Float32Array(this.initialBufferSize);
    }
    this.writePos = 0;
    this.readPos = 0;
    this.samplesConsumed = 0;
    this.isStarted = false;
    this.isComplete = false;
    this.hasEnded = false;  // Reset the ended guard for new sentence
    this.isPaused = false;
    this.lastProgressTime = 0;  // Reset progress throttle
    // Set playbackRate atomically during reset if provided
    // This prevents race condition where chunks arrive before setPlaybackRate message
    if (playbackRate !== null && playbackRate !== undefined) {
      this.playbackRate = Math.max(0.5, Math.min(2.0, playbackRate));
    }
    // Otherwise playbackRate is preserved across resets
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

    // Stream audio from buffer with playback rate support using linear interpolation
    for (let i = 0; i < output.length; i++) {
      const intPos = Math.floor(this.readPos);

      if (intPos + 1 < this.writePos) {
        // Linear interpolation between samples for smooth playback rate changes
        const frac = this.readPos - intPos;
        const sample1 = this.buffer[intPos];
        const sample2 = this.buffer[intPos + 1];
        output[i] = sample1 + frac * (sample2 - sample1);

        // Advance read position by playback rate
        this.readPos += this.playbackRate;
        this.samplesConsumed++;
      } else if (intPos < this.writePos) {
        // Last sample - no interpolation needed
        output[i] = this.buffer[intPos];
        this.readPos += this.playbackRate;
        this.samplesConsumed++;
      } else {
        // Buffer underrun - fill with silence
        output[i] = 0;
      }
    }

    // Report progress and completion (only when not paused)
    // CRITICAL: Only send 'ended' ONCE to prevent duplicate sentenceEnd events
    const intReadPos = Math.floor(this.readPos);
    if (this.isComplete && intReadPos >= this.writePos && !this.hasEnded) {
      this.hasEnded = true;
      this.port.postMessage({
        type: 'ended',
        samplesConsumed: this.samplesConsumed
      });
    } else if (!this.hasEnded) {
      // Performance optimization #1: Throttle progress to 30Hz
      // Calculate current time in ms from samples consumed
      const currentTimeMs = (this.samplesConsumed / 44100) * 1000;
      if (currentTimeMs - this.lastProgressTime >= this.progressThrottleMs) {
        this.lastProgressTime = currentTimeMs;
        const progress = this.writePos > 0 ? intReadPos / this.writePos : 0;
        this.port.postMessage({
          type: 'progress',
          progress,
          readPos: intReadPos,
          writePos: this.writePos,
          samplesConsumed: this.samplesConsumed
        });
      }
    }

    return true;
  }
}

registerProcessor('streaming-processor', StreamingProcessor);
