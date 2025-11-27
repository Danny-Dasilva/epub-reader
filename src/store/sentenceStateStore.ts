import { create } from 'zustand';

// Sentence audio state for visual feedback
export type SentenceAudioState = 'pending' | 'preloading' | 'ready' | 'playing' | 'played' | 'error';

export interface SentenceStateMap {
  [sentenceId: string]: SentenceAudioState;
}

interface SentenceStateStoreState {
  sentenceStates: SentenceStateMap;
  highlightedSentenceId: string | null;
  highlightedWordIndex: number | null;
}

interface SentenceStateStoreActions {
  setSentenceState: (sentenceId: string, state: SentenceAudioState) => void;
  setSentenceStates: (states: Record<string, SentenceAudioState>) => void;
  clearSentenceStates: () => void;
  setHighlight: (sentenceId: string | null, wordIndex: number | null) => void;
  clearHighlight: () => void;
}

export const useSentenceStateStore = create<SentenceStateStoreState & SentenceStateStoreActions>()(
  (set) => ({
    // Initial state (ephemeral - not persisted)
    sentenceStates: {},
    highlightedSentenceId: null,
    highlightedWordIndex: null,

    // Actions
    setSentenceState: (sentenceId, state) => set((prev) => ({
      sentenceStates: { ...prev.sentenceStates, [sentenceId]: state }
    })),

    setSentenceStates: (states) => set((prev) => ({
      sentenceStates: { ...prev.sentenceStates, ...states }
    })),

    clearSentenceStates: () => set({ sentenceStates: {} }),

    setHighlight: (sentenceId, wordIndex) => set({
      highlightedSentenceId: sentenceId,
      highlightedWordIndex: wordIndex
    }),

    clearHighlight: () => set({
      highlightedSentenceId: null,
      highlightedWordIndex: null
    })
  })
);
