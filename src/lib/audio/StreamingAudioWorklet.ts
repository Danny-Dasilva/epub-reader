/**
 * Streaming Audio Worklet
 * Main thread interface for the streaming audio processor
 * Handles audio chunk buffering and playback with AudioWorklet
 */

/**
 * Check if AudioWorklet is supported in the current environment
 * js-cache-function-results: Result cached since browser capabilities don't change at runtime
 */
let _audioWorkletSupported: boolean | null = null;
export function isAudioWorkletSupported(): boolean {
  if (_audioWorkletSupported !== null) return _audioWorkletSupported;

  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    _audioWorkletSupported = false;
    return false;
  }

  // Check if we're in a secure context (required for AudioWorklet)
  if (!window.isSecureContext) {
    console.warn('[StreamingAudioWorklet] AudioWorklet requires a secure context (HTTPS or localhost)');
    _audioWorkletSupported = false;
    return false;
  }

  // Check if AudioWorklet is available
  try {
    const testContext = new AudioContext();
    _audioWorkletSupported = testContext.audioWorklet !== undefined;
    testContext.close();
    return _audioWorkletSupported;
  } catch {
    _audioWorkletSupported = false;
    return false;
  }
}

export class StreamingAudioWorklet {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private isInitialized = false;
  private isPaused = false;
  private playbackRate = 1.0;
  // FIX #4: Session generation counter to prevent stale chunk processing
  private generation = 0;
  private onStarted: (() => void) | null = null;
  private onEnded: ((samplesConsumed?: number) => void) | null = null;
  private onProgress: ((progress: number, samplesConsumed?: number) => void) | null = null;

  async initialize(audioContext: AudioContext, initialPlaybackRate: number = 1.0): Promise<void> {
    if (this.isInitialized) return;

    this.audioContext = audioContext;
    this.playbackRate = initialPlaybackRate;

    // Check if AudioWorklet is supported
    if (!audioContext.audioWorklet) {
      const reason = !window.isSecureContext
        ? 'AudioWorklet requires a secure context (HTTPS or localhost)'
        : 'AudioWorklet is not supported in this browser';
      console.error(`[StreamingAudioWorklet] ${reason}`);
      throw new Error(`Streaming TTS not available: ${reason}`);
    }

    // Load the worklet module
    try {
      await audioContext.audioWorklet.addModule('/worklets/streaming-processor.js');
    } catch (error) {
      console.error('Failed to load streaming processor worklet:', error);
      throw error;
    }

    // Create worklet node with initial playback rate via processorOptions
    // This eliminates race condition where process() runs before setPlaybackRate message
    this.workletNode = new AudioWorkletNode(audioContext, 'streaming-processor', {
      processorOptions: { initialPlaybackRate: this.playbackRate }
    });

    // Create gain node for volume control
    this.gainNode = audioContext.createGain();

    // Connect: worklet -> gain -> destination
    this.workletNode.connect(this.gainNode);

    // Set up message handler
    this.workletNode.port.onmessage = (event) => {
      const message = event.data;

      if (message.type === 'started') {
        this.onStarted?.();
      } else if (message.type === 'ended') {
        this.onEnded?.(message.samplesConsumed);
      } else if (message.type === 'progress') {
        this.onProgress?.(message.progress, message.samplesConsumed);
      }
    };

    this.isInitialized = true;
    // NOTE: playbackRate already set via processorOptions - no async message needed
  }

  setCallbacks(callbacks: {
    onStarted?: () => void;
    onEnded?: (samplesConsumed?: number) => void;
    onProgress?: (progress: number, samplesConsumed?: number) => void;
  }): void {
    this.onStarted = callbacks.onStarted || null;
    this.onEnded = callbacks.onEnded || null;
    this.onProgress = callbacks.onProgress || null;
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2.0, rate));
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'setPlaybackRate',
        rate: this.playbackRate,
        generation: this.generation
      });
    }
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  connect(destination: AudioNode): void {
    if (!this.gainNode) {
      throw new Error('Worklet not initialized');
    }
    this.gainNode.connect(destination);
  }

  disconnect(): void {
    if (this.gainNode) {
      this.gainNode.disconnect();
    }
  }

  appendChunk(audio: Float32Array): void {
    if (!this.workletNode) {
      throw new Error('Worklet not initialized');
    }

    // Validate input (Fix #9 improvement)
    if (audio.length === 0) return;

    // Send chunk to worklet processor
    // Transfer ownership directly for zero-copy performance
    // Note: After this call, the original array becomes detached and unusable
    // Caller must not access the array after calling appendChunk
    // FIX #4: Include generation to allow processor to ignore stale chunks
    this.workletNode.port.postMessage(
      {
        type: 'chunk',
        audio: audio,
        generation: this.generation
      },
      [audio.buffer]
    );
  }

  markComplete(): void {
    if (!this.workletNode) {
      throw new Error('Worklet not initialized');
    }

    this.workletNode.port.postMessage({
      type: 'complete',
      generation: this.generation
    });
  }

  reset(): void {
    if (!this.workletNode) {
      throw new Error('Worklet not initialized');
    }

    // FIX #4: Increment generation so processor ignores stale chunks
    this.generation++;
    this.workletNode.port.postMessage({ type: 'reset', generation: this.generation });
    this.isPaused = false;
  }

  /**
   * Reset worklet with atomic playback rate setting
   * This prevents race conditions where chunks arrive before setPlaybackRate message
   */
  resetWithPlaybackRate(rate: number): void {
    if (!this.workletNode) {
      throw new Error('Worklet not initialized');
    }

    this.playbackRate = Math.max(0.5, Math.min(2.0, rate));
    // FIX #4: Increment generation so processor ignores stale chunks
    this.generation++;
    // Send playbackRate and generation inside reset message for atomic update
    this.workletNode.port.postMessage({
      type: 'reset',
      playbackRate: this.playbackRate,
      generation: this.generation
    });
    this.isPaused = false;
  }

  /**
   * Performance optimization #10: Pre-allocate buffer based on estimated duration
   * Call this before streaming to reduce dynamic reallocations
   * @param estimatedDurationMs Expected audio duration in milliseconds
   * @param sampleRate Audio sample rate (default 44100)
   */
  preallocateBuffer(estimatedDurationMs: number, sampleRate = 44100): void {
    if (!this.workletNode) return;

    const estimatedSamples = Math.ceil((estimatedDurationMs / 1000) * sampleRate);
    this.workletNode.port.postMessage({
      type: 'preallocate',
      estimatedSamples
    });
  }

  pause(): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'pause',
      generation: this.generation
    });
    this.isPaused = true;
  }

  resume(): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'resume',
      generation: this.generation
    });
    this.isPaused = false;
  }

  getIsPaused(): boolean {
    return this.isPaused;
  }

  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  dispose(): void {
    this.disconnect();

    if (this.workletNode) {
      // Clean up message handler to prevent memory leaks
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    this.gainNode = null;
    this.audioContext = null;
    this.isInitialized = false;
    this.isPaused = false;
    this.playbackRate = 1.0;
    this.onStarted = null;
    this.onEnded = null;
    this.onProgress = null;
  }
}

export function createStreamingAudioWorklet(): StreamingAudioWorklet {
  return new StreamingAudioWorklet();
}
