import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ParsedBook, Chapter, Sentence } from '@/lib/epub';

export type Theme = 'light' | 'dark' | 'sepia';

// Note: Sentence audio state management moved to sentenceStateStore.ts to avoid duplication

interface ReaderState {
  // Current book data (not persisted - loaded fresh each time)
  currentBook: ParsedBook | null;
  currentChapterIndex: number;
  currentSentenceIndex: number;

  // UI State
  theme: Theme;
  fontSize: number;
  showToc: boolean;
  showSettings: boolean;

  // Playback state
  isPlaying: boolean;
  speechRate: number;        // TTS generation speed (how fast the model speaks)
  audioPlaybackRate: number; // Audio playback speed (how fast audio plays)
  volume: number;

  // TTS state
  ttsReady: boolean;
  ttsLoading: boolean;
  ttsBackend: 'webgpu' | 'wasm' | null;
  currentVoice: string;

  // Actions
  setCurrentBook: (book: ParsedBook | null) => void;
  setChapter: (index: number) => void;
  setSentence: (index: number) => void;
  nextSentence: () => boolean; // Returns false if at end
  prevSentence: () => boolean;
  nextChapter: () => boolean;
  prevChapter: () => boolean;

  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setShowToc: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;

  setIsPlaying: (playing: boolean) => void;
  setSpeechRate: (rate: number) => void;
  setAudioPlaybackRate: (rate: number) => void;
  setVolume: (volume: number) => void;

  setTTSReady: (ready: boolean) => void;
  setTTSLoading: (loading: boolean) => void;
  setTTSBackend: (backend: 'webgpu' | 'wasm' | null) => void;
  setCurrentVoice: (voice: string) => void;

  // Getters
  getCurrentChapter: () => Chapter | null;
  getCurrentSentence: () => Sentence | null;
}

export const useReaderStore = create<ReaderState>()(
  persist(
    (set, get) => ({
      // Initial state
      currentBook: null,
      currentChapterIndex: 0,
      currentSentenceIndex: 0,

      theme: 'dark',
      fontSize: 20,
      showToc: false,
      showSettings: false,

      isPlaying: false,
      speechRate: 1.05,        // Default TTS generation speed
      audioPlaybackRate: 1.0,  // Default audio playback speed
      volume: 1.0,

      ttsReady: false,
      ttsLoading: false,
      ttsBackend: null,
      currentVoice: 'F1',

      // Actions
      setCurrentBook: (book) => set({
        currentBook: book,
        currentChapterIndex: 0,
        currentSentenceIndex: 0
      }),

      setChapter: (index) => {
        const { currentBook } = get();
        if (!currentBook || index < 0 || index >= currentBook.chapters.length) return;
        set({
          currentChapterIndex: index,
          currentSentenceIndex: 0
        });
      },

      setSentence: (index) => {
        const chapter = get().getCurrentChapter();
        if (!chapter || index < 0 || index >= chapter.sentences.length) return;
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
        if (currentChapterIndex < currentBook.chapters.length - 1) {
          set({
            currentChapterIndex: currentChapterIndex + 1,
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
        if (currentChapterIndex > 0) {
          const prevChapter = currentBook.chapters[currentChapterIndex - 1];
          set({
            currentChapterIndex: currentChapterIndex - 1,
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

      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setShowToc: (showToc) => set({ showToc }),
      setShowSettings: (showSettings) => set({ showSettings }),

      setIsPlaying: (isPlaying) => set({ isPlaying }),
      setSpeechRate: (speechRate) => set({ speechRate }),
      setAudioPlaybackRate: (audioPlaybackRate) => set({ audioPlaybackRate }),
      setVolume: (volume) => set({ volume }),

      setTTSReady: (ttsReady) => set({ ttsReady }),
      setTTSLoading: (ttsLoading) => set({ ttsLoading }),
      setTTSBackend: (ttsBackend) => set({ ttsBackend }),
      setCurrentVoice: (currentVoice) => set({ currentVoice }),

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
    }),
    {
      name: 'epub-reader-state',
      partialize: (state) => ({
        theme: state.theme,
        fontSize: state.fontSize,
        speechRate: state.speechRate,
        audioPlaybackRate: state.audioPlaybackRate,
        volume: state.volume,
        currentVoice: state.currentVoice
      })
    }
  )
);
