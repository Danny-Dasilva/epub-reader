import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_INFLECT_VOICE_ID, getInflectVoice } from '@/lib/tts/inflectVoices';

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
      currentVoice: DEFAULT_INFLECT_VOICE_ID,

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
      }),
      // Existing installs persisted Supertonic IDs such as F5. Resolve those
      // to the Inflect default instead of retaining a stale audio-cache key.
      merge: (persisted, current) => {
        const saved = persisted as Partial<TTSState> | undefined;
        return {
          ...current,
          ...saved,
          currentVoice: getInflectVoice(saved?.currentVoice ?? current.currentVoice).id,
        };
      },
    }
  )
);
