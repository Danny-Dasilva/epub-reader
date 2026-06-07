import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PlaybackSession {
  abortController: AbortController | null;
  isPaused: boolean;
}

interface PlaybackState {
  isPlaying: boolean;
  volume: number;
  speechRate: number;
  audioPlaybackRate: number;
  allowBackgroundPlayback: boolean;
  enableASR: boolean;  // Enable ASR word timestamp refinement (loads ~50MB Parakeet model)
  enableIndexedDBStorage: boolean;  // Enable IndexedDB storage with compression
  enableLazyVoiceLoading: boolean;  // Enable lazy voice loading (loads only selected voice on init)
  enableAudioCaching: boolean;  // Enable service worker audio caching for instant replay
  session: PlaybackSession;
  _hasHydrated: boolean;
}

interface PlaybackActions {
  setIsPlaying: (playing: boolean) => void;
  setVolume: (volume: number) => void;
  setSpeechRate: (rate: number) => void;
  setAudioPlaybackRate: (rate: number) => void;
  setAllowBackgroundPlayback: (allow: boolean) => void;
  setEnableASR: (enabled: boolean) => void;
  setEnableIndexedDBStorage: (enabled: boolean) => void;
  setEnableLazyVoiceLoading: (enabled: boolean) => void;
  setEnableAudioCaching: (enabled: boolean) => void;
  startSession: () => AbortController;
  endSession: () => void;
  setPaused: (paused: boolean) => void;
}

const initialSession: PlaybackSession = {
  abortController: null,
  isPaused: false
};

export const usePlaybackStore = create<PlaybackState & PlaybackActions>()(
  persist(
    (set, get) => ({
      // Initial state
      isPlaying: false,
      volume: 1.0,
      speechRate: 1.05,
      audioPlaybackRate: 1.0,
      allowBackgroundPlayback: false,
      enableASR: false,  // Default disabled to save ~50MB Parakeet model download
      enableIndexedDBStorage: true,  // Enable IndexedDB by default
      enableLazyVoiceLoading: true,  // Enable lazy voice loading by default
      enableAudioCaching: true,  // Enable audio caching by default for instant replay
      session: initialSession,
      _hasHydrated: false,

      // Actions
      setIsPlaying: (isPlaying) => set({ isPlaying }),

      setVolume: (volume) => set({ volume }),

      setSpeechRate: (speechRate) => set({ speechRate }),

      setAudioPlaybackRate: (audioPlaybackRate) => set({ audioPlaybackRate }),

      setAllowBackgroundPlayback: (allowBackgroundPlayback) => set({ allowBackgroundPlayback }),

      setEnableASR: (enableASR) => set({ enableASR }),

      setEnableIndexedDBStorage: (enableIndexedDBStorage) => set({ enableIndexedDBStorage }),

      setEnableLazyVoiceLoading: (enableLazyVoiceLoading) => set({ enableLazyVoiceLoading }),

      setEnableAudioCaching: (enableAudioCaching) => set({ enableAudioCaching }),

      startSession: () => {
        const { session } = get();

        // Abort previous operations
        if (session.abortController) {
          session.abortController.abort();
        }

        const abortController = new AbortController();
        set({
          session: {
            abortController,
            isPaused: false
          }
        });
        return abortController;
      },

      endSession: () => {
        const { session } = get();
        if (session.abortController) {
          session.abortController.abort();
        }
        set({ session: initialSession });
      },

      setPaused: (isPaused) => set((state) => ({
        session: { ...state.session, isPaused }
      }))
    }),
    {
      name: 'epub-reader-playback',
      partialize: (state) => ({
        volume: state.volume,
        speechRate: state.speechRate,
        audioPlaybackRate: state.audioPlaybackRate,
        allowBackgroundPlayback: state.allowBackgroundPlayback,
        enableASR: state.enableASR,
        enableIndexedDBStorage: state.enableIndexedDBStorage,
        enableLazyVoiceLoading: state.enableLazyVoiceLoading,
        enableAudioCaching: state.enableAudioCaching
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state._hasHydrated = true;
      }
    }
  )
);
