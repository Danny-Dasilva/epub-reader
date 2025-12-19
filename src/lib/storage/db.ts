import { openDB, DBSchema, IDBPDatabase } from 'idb';

export interface NarratorDB extends DBSchema {
  books: {
    key: string;
    value: BookRecord;
    indexes: { 'by-lastRead': number };
  };
  audioCache: {
    key: string;
    value: AudioCacheRecord;
    indexes: { 'by-timestamp': number; 'by-bookId': string };
  };
  progress: {
    key: string;
    value: ProgressRecord;
  };
}

export interface BookRecord {
  id: string;
  metadata: {
    id: string;
    title: string;
    author: string;
    addedAt: number;
    lastReadAt: number;
    progress: number;
  };
  chaptersCompressed: Uint8Array;
  tocCompressed: Uint8Array;
  cover: Blob | null;
  addedAt: number;
  lastReadAt: number;
}

export interface AudioCacheRecord {
  id: string;
  bookId: string;
  sentenceId: string;
  audioBlob: Blob;
  timestamp: number;
}

export interface ProgressRecord {
  bookId: string;
  chapterIndex: number;
  sentenceIndex: number;
  scrollPosition: number;
  lastReadAt: number;
}

const DB_NAME = 'narrator-db';
const DB_VERSION = 1;

let dbInstance: IDBPDatabase<NarratorDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<NarratorDB>> {
  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = await openDB<NarratorDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, transaction) {
      // Create books store
      if (!db.objectStoreNames.contains('books')) {
        const booksStore = db.createObjectStore('books', { keyPath: 'id' });
        booksStore.createIndex('by-lastRead', 'lastReadAt');
      }

      // Create audioCache store
      if (!db.objectStoreNames.contains('audioCache')) {
        const audioCacheStore = db.createObjectStore('audioCache', { keyPath: 'id' });
        audioCacheStore.createIndex('by-timestamp', 'timestamp');
        audioCacheStore.createIndex('by-bookId', 'bookId');
      }

      // Create progress store
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'bookId' });
      }
    },
    blocked() {
      console.warn('IndexedDB upgrade blocked - close other tabs');
    },
    blocking() {
      console.warn('IndexedDB blocking - this tab is blocking upgrade');
      // Close and reopen to allow upgrade
      dbInstance?.close();
      dbInstance = null;
    },
    terminated() {
      console.error('IndexedDB connection terminated unexpectedly');
      dbInstance = null;
    }
  });

  return dbInstance;
}

export async function closeDB(): Promise<void> {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
