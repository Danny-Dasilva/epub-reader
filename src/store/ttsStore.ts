import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TTSState {
  ttsReady: boolean;
  ttsLoading: boolean;
  ttsBackend: 'webgpu' | 'wasm' | null;
  currentVoice: string;
}

interface TTSActions {
  setTTSReady: (ready: boolean) => void;
  setTTSLoading: (loading: boolean) => void;
  setTTSBackend: (backend: 'webgpu' | 'wasm' | null) => void;
  setCurrentVoice: (voice: string) => void;
}

export const useTTSStore = create<TTSState & TTSActions>()(
  persist(
    (set) => ({
      // Initial state
      ttsReady: false,
      ttsLoading: false,
      ttsBackend: null,
      currentVoice: 'F5',

      // Actions
      setTTSReady: (ttsReady) => set({ ttsReady }),
      setTTSLoading: (ttsLoading) => set({ ttsLoading }),
      setTTSBackend: (ttsBackend) => set({ ttsBackend }),
      setCurrentVoice: (currentVoice) => set({ currentVoice })
    }),
    {
      name: 'epub-reader-tts',
      partialize: (state) => ({
        currentVoice: state.currentVoice
      })
    }
  )
);
