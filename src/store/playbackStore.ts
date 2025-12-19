import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PlaybackSession {
  abortController: AbortController | null;
  sentenceId: string | null;
  chapterIndex: number;
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
  enableStreamingTTS: boolean;  // Enable streaming TTS for faster time-to-first-audio (~500ms vs 2-4s)
  session: PlaybackSession;
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
  setEnableStreamingTTS: (enabled: boolean) => void;
  startSession: (sentenceId: string, chapterIndex: number) => AbortController;
  endSession: () => void;
  setPaused: (paused: boolean) => void;
  updateSessionSentence: (sentenceId: string) => void;
}

const initialSession: PlaybackSession = {
  abortController: null,
  sentenceId: null,
  chapterIndex: 0,
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
      enableStreamingTTS: false,  // Disable streaming TTS by default
      session: initialSession,

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

      setEnableStreamingTTS: (enableStreamingTTS) => set({ enableStreamingTTS }),

      startSession: (sentenceId, chapterIndex) => {
        const { session } = get();

        // Idempotent for same sentence - don't abort in-progress synthesis
        // This prevents killing ongoing TTS synthesis when effect re-runs
        if (session.sentenceId === sentenceId && session.abortController && !session.abortController.signal.aborted) {
          // Same sentence, keep existing controller to preserve in-flight synthesis
          return session.abortController;
        }

        // Different sentence - abort previous operations
        if (session.abortController) {
          session.abortController.abort();
        }

        const abortController = new AbortController();
        set({
          session: {
            abortController,
            sentenceId,
            chapterIndex,
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
      })),

      updateSessionSentence: (sentenceId) => set((state) => ({
        session: { ...state.session, sentenceId }
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
        enableAudioCaching: state.enableAudioCaching,
        enableStreamingTTS: state.enableStreamingTTS
      })
    }
  )
);
