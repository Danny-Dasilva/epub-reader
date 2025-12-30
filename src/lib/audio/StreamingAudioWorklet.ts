/**
 * Streaming Audio Worklet
 * Main thread interface for the streaming audio processor
 * Handles audio chunk buffering and playback with AudioWorklet
 */

/**
 * Check if AudioWorklet is supported in the current environment
 */
export function isAudioWorkletSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof AudioContext === 'undefined') return false;

  // Check if we're in a secure context (required for AudioWorklet)
  if (!window.isSecureContext) {
    console.warn('[StreamingAudioWorklet] AudioWorklet requires a secure context (HTTPS or localhost)');
    return false;
  }

  // Check if AudioWorklet is available
  try {
    const testContext = new AudioContext();
    const supported = testContext.audioWorklet !== undefined;
    testContext.close();
    return supported;
  } catch {
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
  private onStarted: (() => void) | null = null;
  private onEnded: ((samplesConsumed?: number) => void) | null = null;
  private onProgress: ((progress: number, samplesConsumed?: number) => void) | null = null;

  async initialize(audioContext: AudioContext): Promise<void> {
    if (this.isInitialized) return;

    this.audioContext = audioContext;

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

    // Create worklet node
    this.workletNode = new AudioWorkletNode(audioContext, 'streaming-processor');

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

    // Apply current playback rate to worklet
    if (this.playbackRate !== 1.0) {
      this.workletNode.port.postMessage({ type: 'setPlaybackRate', rate: this.playbackRate });
    }
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
      this.workletNode.port.postMessage({ type: 'setPlaybackRate', rate: this.playbackRate });
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
    this.workletNode.port.postMessage(
      {
        type: 'chunk',
        audio: audio
      },
      [audio.buffer]
    );
  }

  markComplete(): void {
    if (!this.workletNode) {
      throw new Error('Worklet not initialized');
    }

    this.workletNode.port.postMessage({ type: 'complete' });
  }

  reset(): void {
    if (!this.workletNode) {
      throw new Error('Worklet not initialized');
    }

    this.workletNode.port.postMessage({ type: 'reset' });
    this.isPaused = false;
  }

  pause(): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'pause' });
    this.isPaused = true;
  }

  resume(): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'resume' });
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
