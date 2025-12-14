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
  session: PlaybackSession;
}

interface PlaybackActions {
  setIsPlaying: (playing: boolean) => void;
  setVolume: (volume: number) => void;
  setSpeechRate: (rate: number) => void;
  setAudioPlaybackRate: (rate: number) => void;
  setAllowBackgroundPlayback: (allow: boolean) => void;
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
      session: initialSession,

      // Actions
      setIsPlaying: (isPlaying) => set({ isPlaying }),

      setVolume: (volume) => set({ volume }),

      setSpeechRate: (speechRate) => set({ speechRate }),

      setAudioPlaybackRate: (audioPlaybackRate) => set({ audioPlaybackRate }),

      setAllowBackgroundPlayback: (allowBackgroundPlayback) => set({ allowBackgroundPlayback }),

      startSession: (sentenceId, chapterIndex) => {
        // Abort any existing session
        const { session } = get();
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
        allowBackgroundPlayback: state.allowBackgroundPlayback
      })
    }
  )
);
