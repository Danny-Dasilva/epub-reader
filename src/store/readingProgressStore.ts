import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Reading progress for a single book
 */
export interface BookProgress {
  chapterIndex: number;
  sentenceIndex: number;
  lastReadAt: number;
}

/**
 * Map of bookId -> progress
 */
type ProgressMap = Record<string, BookProgress>;

interface ReadingProgressState {
  progress: ProgressMap;
}

interface ReadingProgressActions {
  /**
   * Get saved progress for a book
   */
  getProgress: (bookId: string) => BookProgress | null;

  /**
   * Save progress for a book
   */
  saveProgress: (bookId: string, chapterIndex: number, sentenceIndex: number) => void;

  /**
   * Clear progress for a book
   */
  clearProgress: (bookId: string) => void;
}

/**
 * Store for persisting reading progress per book.
 * Saves chapter and sentence index to localStorage so users
 * can resume reading where they left off.
 */
export const useReadingProgressStore = create<ReadingProgressState & ReadingProgressActions>()(
  persist(
    (set, get) => ({
      progress: {},

      getProgress: (bookId: string) => {
        return get().progress[bookId] ?? null;
      },

      saveProgress: (bookId: string, chapterIndex: number, sentenceIndex: number) => {
        set((state) => ({
          progress: {
            ...state.progress,
            [bookId]: {
              chapterIndex,
              sentenceIndex,
              lastReadAt: Date.now()
            }
          }
        }));
      },

      clearProgress: (bookId: string) => {
        set((state) => {
          const { [bookId]: _, ...rest } = state.progress;
          return { progress: rest };
        });
      }
    }),
    {
      name: 'epub-reader-progress',
      // Only persist the progress map
      partialize: (state) => ({ progress: state.progress })
    }
  )
);
