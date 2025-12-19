// Narrator Service Worker
const CACHE_NAME = 'narrator-v1';
const MODEL_CACHE_NAME = 'narrator-models-v1';
const AUDIO_CACHE_NAME = 'narrator-audio-v1';

// Static assets to cache immediately
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
];

// Model files to cache (will be added dynamically)
const MODEL_PATTERNS = [
  /\/models\/tts\/.+\.onnx$/,
  /\/voice_styles\/.+\.bin$/,
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => {
            return name.startsWith('narrator-') &&
                   name !== CACHE_NAME &&
                   name !== MODEL_CACHE_NAME &&
                   name !== AUDIO_CACHE_NAME;
          })
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Check if this is a model file
  const isModelFile = MODEL_PATTERNS.some((pattern) => pattern.test(url.pathname));

  if (isModelFile) {
    // Cache-first strategy for model files
    event.respondWith(
      caches.open(MODEL_CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          return fetch(request).then((networkResponse) => {
            if (networkResponse.ok) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          });
        });
      })
    );
    return;
  }

  // For HTML pages, use network-first strategy
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match('/');
      })
    );
    return;
  }

  // For other assets, use stale-while-revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(request).then((cachedResponse) => {
        const fetchPromise = fetch(request).then((networkResponse) => {
          if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      });
    })
  );
});

// ============================================
// Audio Caching
// ============================================

const AUDIO_CACHE_MAX_ENTRIES = 5000;

// Hash function for cache key
async function hashString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// Build cache key
async function buildAudioCacheKey(bookId, chapterId, sentenceId, text, voice, speechRate) {
  const hash = await hashString(`${text}|${voice}|${speechRate}`);
  return `narrator-audio/${bookId}/${chapterId}/${sentenceId}/${hash}`;
}

// Cache audio blob
async function cacheAudio(key, audioBlob) {
  const cache = await caches.open(AUDIO_CACHE_NAME);
  await evictAudioIfNeeded(cache);

  const response = new Response(audioBlob, {
    headers: {
      'Content-Type': 'audio/wav',
      'X-Cached-At': Date.now().toString(),
      'X-Cache-Key': key,
    }
  });
  await cache.put(key, response);
}

// Retrieve cached audio
async function getCachedAudio(key) {
  const cache = await caches.open(AUDIO_CACHE_NAME);
  const response = await cache.match(key);
  if (response) {
    // Update timestamp for LRU
    const blob = await response.blob();
    const newResponse = new Response(blob, {
      headers: {
        'Content-Type': 'audio/wav',
        'X-Cached-At': Date.now().toString(),
        'X-Cache-Key': key,
      }
    });
    await cache.put(key, newResponse);
    return blob;
  }
  return null;
}

// LRU eviction
async function evictAudioIfNeeded(cache) {
  const keys = await cache.keys();
  if (keys.length < AUDIO_CACHE_MAX_ENTRIES) return;

  // Gather entries with timestamps
  const entries = await Promise.all(
    keys.map(async (request) => {
      const response = await cache.match(request);
      const cachedAt = parseInt(response?.headers.get('X-Cached-At') || '0', 10);
      return { request, cachedAt };
    })
  );

  // Sort by timestamp, delete oldest 10%
  entries.sort((a, b) => a.cachedAt - b.cachedAt);
  const toDelete = Math.max(1, Math.floor(entries.length * 0.1));
  for (let i = 0; i < toDelete; i++) {
    await cache.delete(entries[i].request);
  }
}

// Delete book cache
async function deleteBookAudioCache(bookId) {
  const cache = await caches.open(AUDIO_CACHE_NAME);
  const keys = await cache.keys();
  for (const request of keys) {
    if (request.url.includes(`narrator-audio/${bookId}/`)) {
      await cache.delete(request);
    }
  }
}

// Get cache stats
async function getAudioCacheStats() {
  const cache = await caches.open(AUDIO_CACHE_NAME);
  const keys = await cache.keys();
  let totalSize = 0;
  for (const request of keys) {
    const response = await cache.match(request);
    if (response) {
      const blob = await response.blob();
      totalSize += blob.size;
    }
  }
  return { entries: keys.length, size: totalSize };
}

// Handle messages from the app
self.addEventListener('message', async (event) => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'CACHE_AUDIO': {
      const { bookId, chapterId, sentenceId, text, voice, speechRate, audioBlob } = payload;
      const key = await buildAudioCacheKey(bookId, chapterId, sentenceId, text, voice, speechRate);
      await cacheAudio(key, audioBlob);
      event.ports[0]?.postMessage({ success: true, key });
      break;
    }
    case 'GET_CACHED_AUDIO': {
      const { bookId, chapterId, sentenceId, text, voice, speechRate } = payload;
      const key = await buildAudioCacheKey(bookId, chapterId, sentenceId, text, voice, speechRate);
      const blob = await getCachedAudio(key);
      event.ports[0]?.postMessage({ blob, key });
      break;
    }
    case 'DELETE_BOOK_AUDIO': {
      const { bookId } = payload;
      await deleteBookAudioCache(bookId);
      event.ports[0]?.postMessage({ success: true });
      break;
    }
    case 'GET_AUDIO_CACHE_STATS': {
      const stats = await getAudioCacheStats();
      event.ports[0]?.postMessage(stats);
      break;
    }
    case 'SKIP_WAITING': {
      self.skipWaiting();
      break;
    }
  }
});
