/**
 * ReadingPaceTracker
 *
 * Tracks actual reading pace during TTS playback to estimate time remaining.
 * Uses a rolling window of recent sentence durations to compute average pace.
 */

interface PaceSample {
  timestamp: number;
  durationMs: number; // time for one sentence
}

export class ReadingPaceTracker {
  private samples: PaceSample[] = [];
  private maxSamples = 50;
  private sessionStartTime: number | null = null;

  /**
   * Start a new reading session
   */
  startSession(): void {
    this.sessionStartTime = Date.now();
    this.samples = [];
  }

  /**
   * Record the completion of a sentence with its duration
   * @param durationMs Time it took to read/speak the sentence in milliseconds
   */
  recordSentenceComplete(durationMs: number): void {
    // Validate duration is reasonable (between 100ms and 30s)
    if (durationMs < 100 || durationMs > 30000) {
      return;
    }

    const sample: PaceSample = {
      timestamp: Date.now(),
      durationMs
    };

    this.samples.push(sample);

    // Keep only the most recent samples
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * Get the average time per sentence based on collected samples
   * @returns Average time per sentence in milliseconds (default 5000ms if no samples)
   */
  getAverageTimePerSentence(): number {
    if (this.samples.length === 0) {
      // Default estimate: ~5 seconds per sentence (typical TTS rate)
      return 5000;
    }

    // Calculate weighted average, giving more weight to recent samples
    let totalWeightedDuration = 0;
    let totalWeight = 0;

    this.samples.forEach((sample, index) => {
      // Linear weighting: more recent samples get higher weight
      const weight = index + 1; // 1, 2, 3, ... (newer samples have higher index)
      totalWeightedDuration += sample.durationMs * weight;
      totalWeight += weight;
    });

    return totalWeightedDuration / totalWeight;
  }

  /**
   * Estimate time required for a given number of sentences
   * @param count Number of sentences
   * @returns Estimated time in milliseconds
   */
  estimateTimeForSentences(count: number): number {
    const avgTime = this.getAverageTimePerSentence();
    return avgTime * count;
  }

  /**
   * Get sentences per minute (reading pace metric)
   * @returns Number of sentences read per minute
   */
  getSentencesPerMinute(): number {
    const avgTimeMs = this.getAverageTimePerSentence();
    const avgTimeMinutes = avgTimeMs / 60000;
    return 1 / avgTimeMinutes;
  }

  /**
   * Get the number of samples collected
   */
  getSampleCount(): number {
    return this.samples.length;
  }

  /**
   * Clear all samples
   */
  reset(): void {
    this.samples = [];
    this.sessionStartTime = null;
  }
}
