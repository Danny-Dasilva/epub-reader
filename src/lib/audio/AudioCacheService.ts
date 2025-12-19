/**
 * Audio Cache Service
 * Client-side interface for service worker audio caching
 *
 * Provides instant replay of TTS audio by caching synthesized audio blobs
 * in the Service Worker Cache API. Cache keys include voice and speechRate
 * to ensure proper invalidation when settings change.
 */

export interface AudioCacheParams {
  bookId: string;
  chapterId: number;
  sentenceId: string;
  text: string;
  voice: string;
  speechRate: number;
}

export interface AudioCacheStats {
  entries: number;
  size: number;
}

/**
 * Timeout for service worker responses (5 seconds)
 */
const SW_TIMEOUT_MS = 5000;

class AudioCacheService {
  private swReady: Promise<ServiceWorkerRegistration | null>;
  private enabled: boolean = true;

  constructor() {
    this.swReady = this.waitForServiceWorker();
  }

  /**
   * Wait for service worker to be ready
   */
  private async waitForServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      console.warn('[AudioCache] Service Worker not supported');
      this.enabled = false;
      return null;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      console.log('[AudioCache] Service Worker ready for audio caching');
      return registration;
    } catch (error) {
      console.error('[AudioCache] Failed to wait for service worker:', error);
      this.enabled = false;
      return null;
    }
  }

  /**
   * Send message to service worker with timeout
   */
  private async sendMessage<T>(type: string, payload: object): Promise<T | null> {
    if (!this.enabled) {
      return null;
    }

    const registration = await this.swReady;
    if (!registration || !registration.active) {
      console.warn('[AudioCache] Service worker not active');
      return null;
    }

    return new Promise<T | null>((resolve) => {
      const messageChannel = new MessageChannel();
      let timeoutId: ReturnType<typeof setTimeout>;

      messageChannel.port1.onmessage = (event) => {
        clearTimeout(timeoutId);
        resolve(event.data as T);
      };

      // Timeout fallback
      timeoutId = setTimeout(() => {
        console.warn('[AudioCache] Message timeout:', type);
        messageChannel.port1.close();
        resolve(null);
      }, SW_TIMEOUT_MS);

      try {
        registration.active!.postMessage(
          { type, payload },
          [messageChannel.port2]
        );
      } catch (error) {
        clearTimeout(timeoutId);
        console.error('[AudioCache] Failed to post message:', error);
        resolve(null);
      }
    });
  }

  /**
   * Cache audio blob for a sentence
   * @returns true if successfully cached
   */
  async cacheAudio(params: AudioCacheParams, audioBlob: Blob): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const result = await this.sendMessage<{ success: boolean; key: string }>('CACHE_AUDIO', {
        bookId: params.bookId,
        chapterId: params.chapterId,
        sentenceId: params.sentenceId,
        text: params.text,
        voice: params.voice,
        speechRate: params.speechRate,
        audioBlob: audioBlob,
      });

      if (result?.success) {
        return true;
      }

      return false;
    } catch (error) {
      console.error('[AudioCache] Failed to cache audio:', error);
      return false;
    }
  }

  /**
   * Get cached audio blob for a sentence
   * @returns Blob if found in cache, null otherwise
   */
  async getCachedAudio(params: AudioCacheParams): Promise<Blob | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const result = await this.sendMessage<{ blob: Blob | null; key: string }>('GET_CACHED_AUDIO', {
        bookId: params.bookId,
        chapterId: params.chapterId,
        sentenceId: params.sentenceId,
        text: params.text,
        voice: params.voice,
        speechRate: params.speechRate,
      });

      return result?.blob || null;
    } catch (error) {
      console.error('[AudioCache] Failed to get cached audio:', error);
      return null;
    }
  }

  /**
   * Delete all cached audio for a book
   * Call this when a book is removed from the library
   */
  async deleteBookCache(bookId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      await this.sendMessage<{ success: boolean }>('DELETE_BOOK_AUDIO', {
        bookId,
      });
    } catch (error) {
      console.error('[AudioCache] Failed to delete book cache:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<AudioCacheStats | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const stats = await this.sendMessage<AudioCacheStats>('GET_AUDIO_CACHE_STATS', {});
      return stats;
    } catch (error) {
      console.error('[AudioCache] Failed to get cache stats:', error);
      return null;
    }
  }

  /**
   * Enable or disable audio caching
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if audio caching is available and enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton instance
let audioCacheService: AudioCacheService | null = null;

/**
 * Get the singleton AudioCacheService instance
 */
export function getAudioCacheService(): AudioCacheService {
  if (!audioCacheService) {
    audioCacheService = new AudioCacheService();
  }
  return audioCacheService;
}
