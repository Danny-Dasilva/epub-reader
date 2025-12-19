import { ParsedBook } from '@/lib/epub/types';
import { getBookStorage } from './bookStorage';
import { supportsNativeCompression } from './compression';

/**
 * Migrate books from sessionStorage to IndexedDB
 * Returns the number of books migrated
 */
export async function migrateFromSessionStorage(): Promise<number> {
  if (!supportsNativeCompression()) {
    console.warn('Cannot migrate: compression not supported');
    return 0;
  }

  const storage = getBookStorage();
  let migratedCount = 0;

  try {
    // Scan sessionStorage for book entries
    const bookIds = new Set<string>();

    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('book-')) {
        const bookId = key.replace('book-', '');
        bookIds.add(bookId);
      }
    }

    // Migrate each book
    for (const bookId of bookIds) {
      try {
        // Check if already in IndexedDB
        const exists = await storage.hasBook(bookId);
        if (exists) {
          console.log(`Book ${bookId} already in IndexedDB, skipping`);
          continue;
        }

        // Load from sessionStorage
        const storedData = sessionStorage.getItem(`book-${bookId}`);
        if (!storedData) continue;

        const book = JSON.parse(storedData) as ParsedBook;

        // Save to IndexedDB
        await storage.saveBook(book);
        migratedCount++;

        console.log(`Migrated book: ${book.title} (${bookId})`);

        // Keep in sessionStorage for now as fallback
        // Will be removed gradually as books are re-opened
      } catch (err) {
        console.error(`Failed to migrate book ${bookId}:`, err);
      }
    }

    if (migratedCount > 0) {
      console.log(`Successfully migrated ${migratedCount} book(s) to IndexedDB`);
    }
  } catch (err) {
    console.error('Migration failed:', err);
  }

  return migratedCount;
}

/**
 * Clean up old sessionStorage entries for books that are in IndexedDB
 */
export async function cleanupSessionStorage(): Promise<number> {
  if (!supportsNativeCompression()) {
    return 0;
  }

  const storage = getBookStorage();
  let cleanedCount = 0;

  try {
    const bookIds = new Set<string>();

    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('book-')) {
        const bookId = key.replace('book-', '');
        bookIds.add(bookId);
      }
    }

    for (const bookId of bookIds) {
      const exists = await storage.hasBook(bookId);
      if (exists) {
        sessionStorage.removeItem(`book-${bookId}`);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} sessionStorage entries`);
    }
  } catch (err) {
    console.error('Cleanup failed:', err);
  }

  return cleanedCount;
}
