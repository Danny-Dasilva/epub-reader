import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ParsedBook } from '@/lib/epub';
import { getBookStorage } from '@/lib/storage';

export interface StoredBook {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  addedAt: number;
  lastReadAt: number;
  progress: number; // 0-100
}

interface LibraryState {
  books: StoredBook[];
  currentBookId: string | null;

  // Actions
  addBook: (book: ParsedBook) => void;
  removeBook: (bookId: string) => void;
  setCurrentBook: (bookId: string | null) => void;
  updateProgress: (bookId: string, progress: number) => void;
  updateLastRead: (bookId: string) => void;
  getBook: (bookId: string) => StoredBook | undefined;
  loadBooksFromDB: () => Promise<void>;
  addBookToDB: (book: ParsedBook) => Promise<void>;
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      books: [],
      currentBookId: null,

      addBook: (book: ParsedBook) => {
        const storedBook: StoredBook = {
          id: book.id,
          title: book.title,
          author: book.author,
          cover: book.cover,
          addedAt: Date.now(),
          lastReadAt: Date.now(),
          progress: 0
        };

        set((state) => ({
          books: [...state.books.filter(b => b.id !== book.id), storedBook]
        }));
      },

      removeBook: (bookId: string) => {
        set((state) => ({
          books: state.books.filter(b => b.id !== bookId),
          currentBookId: state.currentBookId === bookId ? null : state.currentBookId
        }));
      },

      setCurrentBook: (bookId: string | null) => {
        set({ currentBookId: bookId });
      },

      updateProgress: (bookId: string, progress: number) => {
        set((state) => ({
          books: state.books.map(b =>
            b.id === bookId ? { ...b, progress } : b
          )
        }));
      },

      updateLastRead: (bookId: string) => {
        set((state) => ({
          books: state.books.map(b =>
            b.id === bookId ? { ...b, lastReadAt: Date.now() } : b
          )
        }));
      },

      getBook: (bookId: string) => {
        return get().books.find(b => b.id === bookId);
      },

      loadBooksFromDB: async () => {
        try {
          const storage = getBookStorage();
          const dbBooks = await storage.listBooks();

          if (dbBooks.length > 0) {
            // Merge with existing books (IndexedDB takes precedence)
            const existingBooks = get().books;
            const mergedBooks = [...dbBooks];

            // Add any books from localStorage that aren't in IndexedDB
            for (const book of existingBooks) {
              if (!dbBooks.find(b => b.id === book.id)) {
                mergedBooks.push(book);
              }
            }

            set({ books: mergedBooks });
          }
        } catch (err) {
          console.error('Failed to load books from IndexedDB:', err);
        }
      },

      addBookToDB: async (book: ParsedBook) => {
        try {
          const storage = getBookStorage();
          await storage.saveBook(book);

          // Update the book in the store if it exists
          const storedBook: StoredBook = {
            id: book.id,
            title: book.title,
            author: book.author,
            cover: book.cover,
            addedAt: Date.now(),
            lastReadAt: Date.now(),
            progress: 0
          };

          set((state) => ({
            books: [...state.books.filter(b => b.id !== book.id), storedBook]
          }));
        } catch (err) {
          console.error('Failed to save book to IndexedDB:', err);
        }
      }
    }),
    {
      name: 'epub-reader-library'
    }
  )
);
