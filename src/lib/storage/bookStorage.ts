import { ParsedBook, Chapter, TOCItem } from '@/lib/epub/types';
import { getDB, BookRecord } from './db';
import { compress, decompress, supportsNativeCompression } from './compression';

export interface StoredBook {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  addedAt: number;
  lastReadAt: number;
  progress: number;
}

export class BookStorage {
  /**
   * Save a complete book to IndexedDB with compression
   */
  async saveBook(book: ParsedBook): Promise<void> {
    if (!supportsNativeCompression()) {
      console.warn('Native compression not supported, falling back to sessionStorage');
      return;
    }

    const db = await getDB();

    // Compress chapters (largest data)
    const chaptersJson = JSON.stringify(book.chapters);
    const chaptersCompressed = await compress(chaptersJson);

    // Compress TOC
    const tocJson = JSON.stringify(book.toc);
    const tocCompressed = await compress(tocJson);

    // Convert cover base64 to Blob if it exists
    let coverBlob: Blob | null = null;
    if (book.cover) {
      try {
        // book.cover is a data URL (data:image/png;base64,...)
        const response = await fetch(book.cover);
        coverBlob = await response.blob();
      } catch (err) {
        console.warn('Failed to convert cover to Blob:', err);
      }
    }

    const record: BookRecord = {
      id: book.id,
      metadata: {
        id: book.id,
        title: book.title,
        author: book.author,
        addedAt: Date.now(),
        lastReadAt: Date.now(),
        progress: 0
      },
      chaptersCompressed,
      tocCompressed,
      cover: coverBlob,
      addedAt: Date.now(),
      lastReadAt: Date.now()
    };

    await db.put('books', record);
  }

  /**
   * Load a complete book from IndexedDB
   */
  async loadBook(id: string): Promise<ParsedBook | null> {
    if (!supportsNativeCompression()) {
      return null;
    }

    try {
      const db = await getDB();
      const record = await db.get('books', id);

      if (!record) {
        return null;
      }

      // Decompress chapters
      const chaptersJson = await decompress(record.chaptersCompressed);
      const chapters = JSON.parse(chaptersJson) as Chapter[];

      // Decompress TOC
      const tocJson = await decompress(record.tocCompressed);
      const toc = JSON.parse(tocJson) as TOCItem[];

      // Convert Blob back to data URL
      let coverDataUrl: string | null = null;
      if (record.cover) {
        try {
          const reader = new FileReader();
          coverDataUrl = await new Promise((resolve, reject) => {
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(record.cover!);
          });
        } catch (err) {
          console.warn('Failed to convert cover Blob to data URL:', err);
        }
      }

      const book: ParsedBook = {
        id: record.id,
        title: record.metadata.title,
        author: record.metadata.author,
        cover: coverDataUrl,
        chapters,
        toc
      };

      return book;
    } catch (err) {
      console.error('Failed to load book from IndexedDB:', err);
      return null;
    }
  }

  /**
   * Load a single chapter (for potential lazy loading in the future)
   */
  async loadChapter(bookId: string, chapterIndex: number): Promise<Chapter | null> {
    const book = await this.loadBook(bookId);
    if (!book || chapterIndex >= book.chapters.length) {
      return null;
    }
    return book.chapters[chapterIndex];
  }

  /**
   * Check if a book exists in IndexedDB
   */
  async hasBook(id: string): Promise<boolean> {
    if (!supportsNativeCompression()) {
      return false;
    }

    try {
      const db = await getDB();
      const record = await db.get('books', id);
      return !!record;
    } catch (err) {
      console.error('Failed to check book existence:', err);
      return false;
    }
  }

  /**
   * List all stored books (metadata only)
   */
  async listBooks(): Promise<StoredBook[]> {
    if (!supportsNativeCompression()) {
      return [];
    }

    try {
      const db = await getDB();
      const records = await db.getAll('books');

      return records.map(record => {
        // Convert Blob cover to data URL if needed
        let coverUrl: string | null = null;
        if (record.cover) {
          coverUrl = URL.createObjectURL(record.cover);
        }

        return {
          id: record.id,
          title: record.metadata.title,
          author: record.metadata.author,
          cover: coverUrl,
          addedAt: record.addedAt,
          lastReadAt: record.lastReadAt,
          progress: record.metadata.progress
        };
      }).sort((a, b) => b.lastReadAt - a.lastReadAt);
    } catch (err) {
      console.error('Failed to list books:', err);
      return [];
    }
  }

  /**
   * Delete a book from IndexedDB
   */
  async deleteBook(id: string): Promise<void> {
    if (!supportsNativeCompression()) {
      return;
    }

    try {
      const db = await getDB();
      await db.delete('books', id);

      // Also delete associated audio cache
      const tx = db.transaction('audioCache', 'readwrite');
      const index = tx.store.index('by-bookId');
      const audioRecords = await index.getAll(id);

      for (const record of audioRecords) {
        await tx.store.delete(record.id);
      }

      await tx.done;
    } catch (err) {
      console.error('Failed to delete book:', err);
    }
  }

  /**
   * Update last read timestamp
   */
  async updateLastRead(id: string): Promise<void> {
    if (!supportsNativeCompression()) {
      return;
    }

    try {
      const db = await getDB();
      const record = await db.get('books', id);

      if (record) {
        record.lastReadAt = Date.now();
        record.metadata.lastReadAt = Date.now();
        await db.put('books', record);
      }
    } catch (err) {
      console.error('Failed to update last read:', err);
    }
  }

  /**
   * Update book progress percentage
   */
  async updateProgress(id: string, progress: number): Promise<void> {
    if (!supportsNativeCompression()) {
      return;
    }

    try {
      const db = await getDB();
      const record = await db.get('books', id);

      if (record) {
        record.metadata.progress = progress;
        await db.put('books', record);
      }
    } catch (err) {
      console.error('Failed to update progress:', err);
    }
  }

  /**
   * Get storage usage statistics
   */
  async getStorageUsage(): Promise<{ used: number; quota: number }> {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      try {
        const estimate = await navigator.storage.estimate();
        return {
          used: estimate.usage || 0,
          quota: estimate.quota || 0
        };
      } catch (err) {
        console.error('Failed to get storage estimate:', err);
      }
    }

    return { used: 0, quota: 0 };
  }
}

// Singleton instance
let bookStorageInstance: BookStorage | null = null;

export function getBookStorage(): BookStorage {
  if (!bookStorageInstance) {
    bookStorageInstance = new BookStorage();
  }
  return bookStorageInstance;
}
