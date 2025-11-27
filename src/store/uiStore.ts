import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'sepia';

interface UIState {
  theme: Theme;
  fontSize: number;
  showToc: boolean;
  showSettings: boolean;
}

interface UIActions {
  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setShowToc: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  toggleSettings: () => void;
}

export const useUIStore = create<UIState & UIActions>()(
  persist(
    (set, get) => ({
      // Initial state
      theme: 'dark',
      fontSize: 20,
      showToc: false,
      showSettings: false,

      // Actions
      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setShowToc: (showToc) => set({ showToc }),
      setShowSettings: (showSettings) => set({ showSettings }),
      toggleSettings: () => set({ showSettings: !get().showSettings })
    }),
    {
      name: 'epub-reader-ui',
      partialize: (state) => ({
        theme: state.theme,
        fontSize: state.fontSize
      })
    }
  )
);
