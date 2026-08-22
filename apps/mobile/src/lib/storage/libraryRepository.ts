import AsyncStorage from '@react-native-async-storage/async-storage';

import type { LibraryBook, ReaderBook, ReaderPosition } from '@/types/reader';

const LIBRARY_KEY = 'narrator:mobile:library:v1';
const bookKey = (id: string) => `narrator:mobile:book:${id}:v1`;
const progressKey = (id: string) => `narrator:mobile:progress:${id}:v1`;

function summarize(book: ReaderBook): LibraryBook {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    cover: book.cover,
    chapterCount: book.chapters.length,
    importedAt: book.importedAt,
  };
}

export const libraryRepository = {
  async list(): Promise<LibraryBook[]> {
    const raw = await AsyncStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as LibraryBook[]).sort((a, b) => b.importedAt - a.importedAt);
  },

  async getBook(id: string): Promise<ReaderBook | null> {
    const raw = await AsyncStorage.getItem(bookKey(id));
    return raw ? (JSON.parse(raw) as ReaderBook) : null;
  },

  async saveBook(book: ReaderBook): Promise<void> {
    const current = await this.list();
    const next = [summarize(book), ...current.filter((item) => item.id !== book.id)];
    await AsyncStorage.multiSet([
      [bookKey(book.id), JSON.stringify(book)],
      [LIBRARY_KEY, JSON.stringify(next)],
    ]);
  },

  async getProgress(bookId: string): Promise<ReaderPosition> {
    const raw = await AsyncStorage.getItem(progressKey(bookId));
    return raw ? (JSON.parse(raw) as ReaderPosition) : { chapterIndex: 0, sentenceIndex: 0 };
  },

  async saveProgress(bookId: string, position: ReaderPosition): Promise<void> {
    await AsyncStorage.setItem(progressKey(bookId), JSON.stringify(position));
  },

  async removeBook(bookId: string): Promise<void> {
    const current = await this.list();
    await AsyncStorage.multiSet([
      [LIBRARY_KEY, JSON.stringify(current.filter((item) => item.id !== bookId))],
    ]);
    await AsyncStorage.multiRemove([bookKey(bookId), progressKey(bookId)]);
  },
};
