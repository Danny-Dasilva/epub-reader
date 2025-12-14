import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'sepia';
export type ScrollPosition = 'top' | 'center';

interface UIState {
  theme: Theme;
  fontSize: number;
  showToc: boolean;
  showSettings: boolean;
  autoScroll: boolean;
  scrollPosition: ScrollPosition;
}

interface UIActions {
  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setShowToc: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  toggleSettings: () => void;
  setAutoScroll: (enabled: boolean) => void;
  setScrollPosition: (position: ScrollPosition) => void;
  toggleAutoScroll: () => void;
}

export const useUIStore = create<UIState & UIActions>()(
  persist(
    (set, get) => ({
      // Initial state
      theme: 'dark',
      fontSize: 20,
      showToc: false,
      showSettings: false,
      autoScroll: true,
      scrollPosition: 'center',

      // Actions
      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setShowToc: (showToc) => set({ showToc }),
      setShowSettings: (showSettings) => set({ showSettings }),
      toggleSettings: () => set({ showSettings: !get().showSettings }),
      setAutoScroll: (autoScroll) => set({ autoScroll }),
      setScrollPosition: (scrollPosition) => set({ scrollPosition }),
      toggleAutoScroll: () => set({ autoScroll: !get().autoScroll })
    }),
    {
      name: 'epub-reader-ui',
      partialize: (state) => ({
        theme: state.theme,
        fontSize: state.fontSize,
        autoScroll: state.autoScroll,
        scrollPosition: state.scrollPosition
      })
    }
  )
);
