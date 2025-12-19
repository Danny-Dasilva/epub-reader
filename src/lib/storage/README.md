# IndexedDB Book Storage

This module provides persistent book storage with GZIP compression for the EPUB reader.

## Features

- **Persistent Storage**: Books survive browser restarts and tab closes
- **GZIP Compression**: 60-80% size reduction using native CompressionStream API
- **Automatic Migration**: Seamlessly migrates books from sessionStorage
- **Fallback Support**: Falls back to sessionStorage if compression not supported
- **Feature Flag**: Can be enabled/disabled via `enableIndexedDBStorage` setting

## Architecture

### Database Schema

The IndexedDB database (`narrator-db`) contains three object stores:

1. **books**: Stores complete book data with compression
   - Key: `bookId` (string)
   - Indexed by: `lastReadAt` (timestamp)
   - Contains: metadata, compressed chapters, compressed TOC, cover blob

2. **audioCache**: Stores pre-generated TTS audio (future feature)
   - Key: `id` (string)
   - Indexed by: `timestamp`, `bookId`

3. **progress**: Stores reading progress (currently handled by Zustand)
   - Key: `bookId` (string)

### Compression

Books are compressed using the native browser `CompressionStream` API with GZIP:

- **Chapters**: JSON stringified and compressed (~70-80% reduction)
- **TOC**: JSON stringified and compressed (~60-70% reduction)
- **Cover**: Stored as Blob instead of base64 data URL (~25% smaller)

### Data Flow

#### Upload Flow
1. User uploads EPUB file
2. EPUB parsed to `ParsedBook` object
3. If `enableIndexedDBStorage` is true:
   - Chapters serialized and compressed
   - TOC serialized and compressed
   - Cover converted from data URL to Blob
   - Saved to IndexedDB
4. Book metadata added to library store

#### Load Flow
1. User opens book in reader
2. If `enableIndexedDBStorage` is true:
   - Load from IndexedDB
   - If not found, check sessionStorage and migrate
3. Else:
   - Load from sessionStorage
4. Decompress chapters and TOC
5. Convert cover Blob back to data URL
6. Display in reader

## Usage

### Basic Operations

```typescript
import { getBookStorage } from '@/lib/storage';

const storage = getBookStorage();

// Save a book
await storage.saveBook(parsedBook);

// Load a book
const book = await storage.loadBook(bookId);

// Check if book exists
const exists = await storage.hasBook(bookId);

// List all books
const books = await storage.listBooks();

// Delete a book
await storage.deleteBook(bookId);

// Update last read time
await storage.updateLastRead(bookId);

// Get storage usage
const { used, quota } = await storage.getStorageUsage();
```

### Migration

```typescript
import { migrateFromSessionStorage } from '@/lib/storage';

// Migrate all books from sessionStorage to IndexedDB
const migratedCount = await migrateFromSessionStorage();
console.log(`Migrated ${migratedCount} books`);
```

### Compression

```typescript
import { compress, decompress, supportsNativeCompression } from '@/lib/storage';

if (supportsNativeCompression()) {
  // Compress data
  const compressed = await compress(jsonString);

  // Decompress data
  const original = await decompress(compressed);
}
```

## Browser Support

IndexedDB compression requires:
- Chrome 80+ (Feb 2020)
- Edge 80+ (Feb 2020)
- Safari 16.4+ (Mar 2023)
- Firefox 113+ (May 2023)

The module automatically falls back to sessionStorage on unsupported browsers.

## Storage Limits

Typical browser storage limits:
- Chrome/Edge: ~60% of available disk space
- Safari: 1GB (iOS), 500MB+ (macOS)
- Firefox: 10% of available disk space (max 2GB)

Average book sizes:
- Uncompressed: 1-5 MB (typical novel)
- Compressed: 200 KB - 1 MB (60-80% reduction)
- Estimated capacity: 500-5000+ books depending on browser/device

## Performance

Compression/decompression benchmarks (M1 MacBook Pro):
- Compress 1MB chapter: ~15-30ms
- Decompress 1MB chapter: ~10-20ms
- Full book save (300KB compressed): ~50-100ms
- Full book load (300KB compressed): ~30-60ms

## Implementation Details

### Why Compress Chapters and TOC?

These are the largest data structures in a book:
- Chapters contain full HTML content, plain text, and sentence arrays
- TOC contains hierarchical navigation structure
- Together they typically represent 95%+ of book data

### Why Store Cover as Blob?

Base64 data URLs are ~33% larger than raw binary data. Converting to Blob:
- Saves ~25% space
- Faster to store/retrieve
- More efficient memory usage

### Why Keep SessionStorage as Fallback?

During the transition period:
- Not all users may have upgraded
- Some browsers don't support compression
- Provides safety net if IndexedDB fails
- Books can be gradually migrated on first access

## Future Enhancements

1. **Audio Cache**: Store generated TTS audio in IndexedDB
2. **Lazy Loading**: Load chapters on-demand instead of entire book
3. **Background Sync**: Sync reading progress across devices
4. **Compression Stats**: Show storage savings to users
5. **Manual Cleanup**: Allow users to free up space
