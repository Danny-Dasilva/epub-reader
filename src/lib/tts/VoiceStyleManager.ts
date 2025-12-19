/**
 * Voice Style Manager
 * Manages caching and lazy loading of voice styles for TTS.
 * Loads only the selected voice on-demand and caches for instant switching.
 * Available voices: M1-M5, F1-F5
 */

import * as ort from 'onnxruntime-web';

interface CachedVoiceStyle {
  ttl: ort.Tensor;
  dp: ort.Tensor;
  loadedAt: number;
}

interface VoiceStyleData {
  style_ttl: {
    data: number[][][];
    dims: number[];
  };
  style_dp: {
    data: number[][][];
    dims: number[];
  };
}

export class VoiceStyleManager {
  private cache: Map<string, CachedVoiceStyle> = new Map();
  private loadingPromises: Map<string, Promise<CachedVoiceStyle>> = new Map();
  private baseUrl: string = '';

  /**
   * Set the base URL for fetching voice styles
   */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /**
   * Load a voice style, using cache if available
   * @param voiceId - Voice identifier (e.g., "M1", "F2")
   * @returns Voice style tensors
   */
  async loadStyle(voiceId: string): Promise<{ ttl: ort.Tensor; dp: ort.Tensor }> {
    // Check cache first
    const cached = this.cache.get(voiceId);
    if (cached) {
      console.log(`[VoiceStyleManager] Cache hit for ${voiceId}`);
      return { ttl: cached.ttl, dp: cached.dp };
    }

    // Check if already loading
    const loadingPromise = this.loadingPromises.get(voiceId);
    if (loadingPromise) {
      console.log(`[VoiceStyleManager] Waiting for in-flight load of ${voiceId}`);
      const result = await loadingPromise;
      return { ttl: result.ttl, dp: result.dp };
    }

    // Load and cache
    console.log(`[VoiceStyleManager] Cache miss for ${voiceId}, loading...`);
    const promise = this.fetchAndCacheStyle(voiceId);
    this.loadingPromises.set(voiceId, promise);

    try {
      const result = await promise;
      return { ttl: result.ttl, dp: result.dp };
    } finally {
      this.loadingPromises.delete(voiceId);
    }
  }

  /**
   * Check if a voice is cached
   */
  isCached(voiceId: string): boolean {
    return this.cache.has(voiceId);
  }

  /**
   * Clear all cached voices
   */
  clearCache(): void {
    // Dispose all tensors before clearing
    for (const [voiceId, cached] of this.cache.entries()) {
      cached.ttl.dispose?.();
      cached.dp.dispose?.();
      console.log(`[VoiceStyleManager] Disposed cache for ${voiceId}`);
    }
    this.cache.clear();
  }

  /**
   * Fetch and cache a voice style from the server
   */
  private async fetchAndCacheStyle(voiceId: string): Promise<CachedVoiceStyle> {
    const startTime = performance.now();
    const voiceStylePath = `/voice_styles/${voiceId}.json`;
    const url = `${this.baseUrl}${voiceStylePath}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load voice style ${voiceId}: ${response.statusText}`);
    }

    const data: VoiceStyleData = await response.json();
    const loadTime = performance.now() - startTime;

    // Convert to tensors
    const ttlData = new Float32Array(data.style_ttl.data.flat(Infinity) as number[]);
    const dpData = new Float32Array(data.style_dp.data.flat(Infinity) as number[]);

    const ttlTensor = new ort.Tensor('float32', ttlData, data.style_ttl.dims);
    const dpTensor = new ort.Tensor('float32', dpData, data.style_dp.dims);

    const cached: CachedVoiceStyle = {
      ttl: ttlTensor,
      dp: dpTensor,
      loadedAt: Date.now(),
    };

    this.cache.set(voiceId, cached);
    console.log(
      `[VoiceStyleManager] Cached ${voiceId} (${Math.round(loadTime)}ms, ~${Math.round(
        JSON.stringify(data).length / 1024
      )}KB)`
    );

    return cached;
  }

  /**
   * Get cache statistics for debugging
   */
  getCacheStats(): { cached: string[]; loading: string[]; size: number } {
    return {
      cached: Array.from(this.cache.keys()),
      loading: Array.from(this.loadingPromises.keys()),
      size: this.cache.size,
    };
  }
}

// Singleton instance for use across the application
let sharedInstance: VoiceStyleManager | null = null;

/**
 * Get the shared VoiceStyleManager instance
 */
export function getVoiceStyleManager(): VoiceStyleManager {
  if (!sharedInstance) {
    sharedInstance = new VoiceStyleManager();
  }
  return sharedInstance;
}

/**
 * Reset the shared instance (useful for testing)
 */
export function resetVoiceStyleManager(): void {
  if (sharedInstance) {
    sharedInstance.clearCache();
    sharedInstance = null;
  }
}
