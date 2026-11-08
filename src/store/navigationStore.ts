import { create } from 'zustand';
import { ParsedBook, Chapter, Sentence } from '@/lib/epub';

interface NavigationState {
  currentBook: ParsedBook | null;
  currentChapterIndex: number;
  currentSentenceIndex: number;
}

interface NavigationActions {
  setCurrentBook: (book: ParsedBook | null) => void;
  setChapter: (index: number) => void;
  setSentenceIndex: (index: number) => void;
  nextSentence: () => boolean;
  prevSentence: () => boolean;
  nextChapter: () => boolean;
  prevChapter: () => boolean;
  getCurrentChapter: () => Chapter | null;
  getCurrentSentence: () => Sentence | null;
}

export const useNavigationStore = create<NavigationState & NavigationActions>()(
  (set, get) => ({
    // Initial state
    currentBook: null,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,

    // Actions
    setCurrentBook: (book) => set({
      currentBook: book,
      currentChapterIndex: 0,
      currentSentenceIndex: 0
    }),

    setChapter: (index) => {
      const { currentBook } = get();
      if (!currentBook || !Number.isInteger(index) || index < 0 || index >= currentBook.chapters.length) return;
      set({
        currentChapterIndex: index,
        currentSentenceIndex: 0
      });
    },

    setSentenceIndex: (index) => {
      const chapter = get().getCurrentChapter();
      if (!chapter || !Number.isInteger(index) || index < 0 || index >= chapter.sentences.length) return;
      set({ currentSentenceIndex: index });
    },

    nextSentence: () => {
      const { currentBook, currentChapterIndex, currentSentenceIndex } = get();
      if (!currentBook) return false;

      const chapter = currentBook.chapters[currentChapterIndex];
      if (!chapter) return false;

      if (currentSentenceIndex < chapter.sentences.length - 1) {
        set({ currentSentenceIndex: currentSentenceIndex + 1 });
        return true;
      }

      // Try next chapter
      const nextChapterIndex = currentBook.chapters.findIndex(
        (nextChapter, index) => index > currentChapterIndex && nextChapter.sentences.length > 0
      );
      if (nextChapterIndex !== -1) {
        set({
          currentChapterIndex: nextChapterIndex,
          currentSentenceIndex: 0
        });
        return true;
      }

      return false; // At the end
    },

    prevSentence: () => {
      const { currentBook, currentChapterIndex, currentSentenceIndex } = get();
      if (!currentBook) return false;

      if (currentSentenceIndex > 0) {
        set({ currentSentenceIndex: currentSentenceIndex - 1 });
        return true;
      }

      // Try previous chapter
      for (let index = currentChapterIndex - 1; index >= 0; index--) {
        const prevChapter = currentBook.chapters[index];
        if (prevChapter.sentences.length === 0) continue;
        set({
          currentChapterIndex: index,
          currentSentenceIndex: prevChapter.sentences.length - 1
        });
        return true;
      }

      return false; // At the beginning
    },

    nextChapter: () => {
      const { currentBook, currentChapterIndex } = get();
      if (!currentBook || currentChapterIndex >= currentBook.chapters.length - 1) return false;
      set({
        currentChapterIndex: currentChapterIndex + 1,
        currentSentenceIndex: 0
      });
      return true;
    },

    prevChapter: () => {
      const { currentChapterIndex } = get();
      if (currentChapterIndex <= 0) return false;
      set({
        currentChapterIndex: currentChapterIndex - 1,
        currentSentenceIndex: 0
      });
      return true;
    },

    // Getters
    getCurrentChapter: () => {
      const { currentBook, currentChapterIndex } = get();
      return currentBook?.chapters[currentChapterIndex] ?? null;
    },

    getCurrentSentence: () => {
      const chapter = get().getCurrentChapter();
      const { currentSentenceIndex } = get();
      return chapter?.sentences[currentSentenceIndex] ?? null;
    }
  })
);
