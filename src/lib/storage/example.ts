/**
 * Example usage of IndexedDB Book Storage
 *
 * This file demonstrates how to use the storage API.
 * Import these functions wherever you need to work with book storage.
 */

import { getBookStorage, migrateFromSessionStorage, supportsNativeCompression } from './index';
import { ParsedBook } from '@/lib/epub/types';

// Check if compression is supported
export function checkCompressionSupport() {
  if (supportsNativeCompression()) {
    console.log('✅ Native compression is supported');
    console.log('Books will be stored with GZIP compression in IndexedDB');
  } else {
    console.log('❌ Native compression not supported');
    console.log('Falling back to sessionStorage without compression');
  }
}

// Save a book to IndexedDB
export async function saveBookExample(book: ParsedBook) {
  const storage = getBookStorage();

  try {
    console.log(`Saving book: ${book.title}`);
    const startTime = performance.now();

    await storage.saveBook(book);

    const endTime = performance.now();
    console.log(`✅ Book saved in ${(endTime - startTime).toFixed(2)}ms`);

    // Get storage stats
    const { used, quota } = await storage.getStorageUsage();
    console.log(`Storage: ${(used / 1024 / 1024).toFixed(2)} MB / ${(quota / 1024 / 1024).toFixed(2)} MB`);
  } catch (error) {
    console.error('❌ Failed to save book:', error);
    throw error;
  }
}

// Load a book from IndexedDB
export async function loadBookExample(bookId: string) {
  const storage = getBookStorage();

  try {
    console.log(`Loading book: ${bookId}`);
    const startTime = performance.now();

    const book = await storage.loadBook(bookId);

    const endTime = performance.now();

    if (book) {
      console.log(`✅ Book loaded in ${(endTime - startTime).toFixed(2)}ms`);
      console.log(`Title: ${book.title}`);
      console.log(`Chapters: ${book.chapters.length}`);
      console.log(`Total sentences: ${book.chapters.reduce((sum, ch) => sum + ch.sentences.length, 0)}`);
      return book;
    } else {
      console.log('❌ Book not found');
      return null;
    }
  } catch (error) {
    console.error('❌ Failed to load book:', error);
    throw error;
  }
}

// List all books
export async function listBooksExample() {
  const storage = getBookStorage();

  try {
    const books = await storage.listBooks();

    console.log(`📚 Found ${books.length} book(s):`);
    books.forEach((book, index) => {
      console.log(`${index + 1}. ${book.title} by ${book.author}`);
      console.log(`   - Added: ${new Date(book.addedAt).toLocaleDateString()}`);
      console.log(`   - Last read: ${new Date(book.lastReadAt).toLocaleDateString()}`);
      console.log(`   - Progress: ${book.progress}%`);
    });

    return books;
  } catch (error) {
    console.error('❌ Failed to list books:', error);
    throw error;
  }
}

// Delete a book
export async function deleteBookExample(bookId: string) {
  const storage = getBookStorage();

  try {
    console.log(`Deleting book: ${bookId}`);

    await storage.deleteBook(bookId);

    console.log('✅ Book deleted');
  } catch (error) {
    console.error('❌ Failed to delete book:', error);
    throw error;
  }
}

// Migrate books from sessionStorage
export async function migrateExample() {
  try {
    console.log('🔄 Starting migration from sessionStorage...');

    const count = await migrateFromSessionStorage();

    if (count > 0) {
      console.log(`✅ Migrated ${count} book(s) to IndexedDB`);
    } else {
      console.log('ℹ️ No books to migrate');
    }

    return count;
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// Get storage statistics
export async function getStorageStatsExample() {
  const storage = getBookStorage();

  try {
    const { used, quota } = await storage.getStorageUsage();

    const usedMB = used / 1024 / 1024;
    const quotaMB = quota / 1024 / 1024;
    const percentUsed = (used / quota) * 100;

    console.log('📊 Storage Statistics:');
    console.log(`Used: ${usedMB.toFixed(2)} MB`);
    console.log(`Quota: ${quotaMB.toFixed(2)} MB`);
    console.log(`Percent used: ${percentUsed.toFixed(2)}%`);

    return { used, quota, usedMB, quotaMB, percentUsed };
  } catch (error) {
    console.error('❌ Failed to get storage stats:', error);
    throw error;
  }
}

// Complete example workflow
export async function completeWorkflowExample(book: ParsedBook) {
  console.log('=== IndexedDB Storage Example Workflow ===\n');

  // 1. Check support
  checkCompressionSupport();
  console.log();

  // 2. Migrate existing books
  await migrateExample();
  console.log();

  // 3. Save a new book
  await saveBookExample(book);
  console.log();

  // 4. List all books
  await listBooksExample();
  console.log();

  // 5. Load the book back
  const loadedBook = await loadBookExample(book.id);
  console.log();

  // 6. Get storage stats
  await getStorageStatsExample();
  console.log();

  // 7. Verify loaded book matches original
  if (loadedBook) {
    const matches =
      loadedBook.id === book.id &&
      loadedBook.title === book.title &&
      loadedBook.chapters.length === book.chapters.length;

    console.log(matches ? '✅ Verification passed' : '❌ Verification failed');
  }

  console.log('\n=== End of Example ===');
}
