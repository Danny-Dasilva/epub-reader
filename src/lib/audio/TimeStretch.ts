/**
 * Time-stretching using SoundTouch's tempo control
 * Changes playback speed WITHOUT changing pitch (like YouTube/Spotify)
 *
 * Uses the WSOLA (Waveform Similarity Overlap-Add) algorithm which
 * processes audio in the time domain to speed up/slow down without
 * affecting pitch - unlike playbackRate which skips samples.
 */

export class TimeStretch {
  private workletNode: AudioWorkletNode | null = null;
  private initialized = false;
  private initializationPromise: Promise<boolean> | null = null;
  private tempo = 1.0;

  /**
   * Initialize the AudioWorklet for time-stretching
   * Must be called after user interaction (browser autoplay policy)
   */
  async initialize(audioContext: AudioContext): Promise<boolean> {
    // Return cached promise if already initializing
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // Already initialized
    if (this.initialized && this.workletNode) {
      return true;
    }

    this.initializationPromise = this.doInitialize(audioContext);
    return this.initializationPromise;
  }

  private async doInitialize(audioContext: AudioContext): Promise<boolean> {
    try {
      // Register the worklet module
      await audioContext.audioWorklet.addModule('/worklets/soundtouch-worklet.js');

      // Create the AudioWorkletNode
      this.workletNode = new AudioWorkletNode(audioContext, 'soundtouch-processor');
      this.initialized = true;

      // Set initial tempo to 1.0 (normal speed)
      this.setTempo(1.0);

      return true;
    } catch (error) {
      console.warn('AudioWorklet time-stretching not supported, falling back to pitched playback:', error);
      this.initialized = false;
      this.workletNode = null;
      return false;
    }
  }

  /**
   * Set playback tempo (speed without pitch change)
   * 1.0 = normal speed
   * 2.0 = 2x speed (audio plays twice as fast, same pitch)
   * 0.5 = half speed (audio plays half as fast, same pitch)
   *
   * This uses SoundTouch's WSOLA algorithm for proper time-stretching,
   * NOT sample rate transposing which would change pitch.
   */
  setTempo(tempo: number): void {
    this.tempo = Math.max(0.5, Math.min(2.0, tempo));

    if (!this.workletNode) return;

    // Use the 'tempo' parameter which does proper time-stretching
    // NOT 'rate' which would change pitch like playbackRate
    const param = this.workletNode.parameters.get('tempo');
    if (param) {
      param.value = this.tempo;
    }
  }

  /**
   * Get current tempo value
   * Needed for word timing calculations
   */
  getTempo(): number {
    return this.tempo;
  }

  /**
   * Get the AudioWorkletNode to insert into the audio graph
   * Returns null if time-stretching is not available
   */
  getNode(): AudioWorkletNode | null {
    return this.workletNode;
  }

  /**
   * Check if time-stretching is available and initialized
   */
  isAvailable(): boolean {
    return this.initialized && this.workletNode !== null;
  }

  /**
   * Connect the time-stretch node between source and destination
   */
  connect(destination: AudioNode): void {
    if (this.workletNode) {
      this.workletNode.connect(destination);
    }
  }

  /**
   * Disconnect the time-stretch node
   */
  disconnect(): void {
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // Already disconnected
      }
    }
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.disconnect();
    this.workletNode = null;
    this.initialized = false;
    this.initializationPromise = null;
  }
}
