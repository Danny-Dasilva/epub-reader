/**
 * GZIP compression/decompression using native CompressionStream API
 * Achieves ~60-80% size reduction for EPUB text content
 */

export function supportsNativeCompression(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

/**
 * Compress a string to GZIP Uint8Array
 */
export async function compress(data: string): Promise<Uint8Array> {
  if (!supportsNativeCompression()) {
    throw new Error('Native compression not supported in this browser');
  }

  // Convert string to UTF-8 bytes
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data);

  // Create compression stream
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });

  // Compress with gzip
  const compressedStream = stream.pipeThrough(
    new CompressionStream('gzip')
  );

  // Read all compressed chunks
  const reader = compressedStream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  // Combine chunks into single Uint8Array
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Decompress GZIP Uint8Array to string
 */
export async function decompress(data: Uint8Array): Promise<string> {
  if (!supportsNativeCompression()) {
    throw new Error('Native compression not supported in this browser');
  }

  // Create decompression stream
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });

  // Decompress with gzip
  const decompressedStream = stream.pipeThrough(
    new DecompressionStream('gzip')
  );

  // Read all decompressed chunks
  const reader = decompressedStream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  // Combine chunks
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert UTF-8 bytes back to string
  const decoder = new TextDecoder();
  return decoder.decode(result);
}

/**
 * Get compression stats for a string
 */
export async function getCompressionStats(data: string): Promise<{
  originalSize: number;
  compressedSize: number;
  ratio: number;
  savedBytes: number;
}> {
  const compressed = await compress(data);
  const originalSize = new TextEncoder().encode(data).length;
  const compressedSize = compressed.length;

  return {
    originalSize,
    compressedSize,
    ratio: (1 - compressedSize / originalSize) * 100,
    savedBytes: originalSize - compressedSize
  };
}
