import { create } from 'zustand';

// Sentence audio state for visual feedback
export type SentenceAudioState = 'pending' | 'preloading' | 'ready' | 'playing' | 'played' | 'error';

// Timestamp source for highlighting accuracy indicator
export type TimestampSource = 'estimated' | 'asr';

export interface SentenceStateMap {
  [sentenceId: string]: SentenceAudioState;
}

interface SentenceStateStoreState {
  sentenceStates: SentenceStateMap;
  highlightedSentenceId: string | null;
  highlightedWordIndex: number | null;
  highlightTimestampSource: TimestampSource | null;  // Track if using accurate ASR timestamps
}

interface SentenceStateStoreActions {
  setSentenceState: (sentenceId: string, state: SentenceAudioState) => void;
  setSentenceStates: (states: Record<string, SentenceAudioState>) => void;
  clearSentenceStates: () => void;
  setHighlight: (sentenceId: string | null, wordIndex: number | null, timestampSource?: TimestampSource) => void;
  clearHighlight: () => void;
}

export const useSentenceStateStore = create<SentenceStateStoreState & SentenceStateStoreActions>()(
  (set) => ({
    // Initial state (ephemeral - not persisted)
    sentenceStates: {},
    highlightedSentenceId: null,
    highlightedWordIndex: null,
    highlightTimestampSource: null,

    // Actions
    setSentenceState: (sentenceId, state) => set((prev) => ({
      sentenceStates: { ...prev.sentenceStates, [sentenceId]: state }
    })),

    setSentenceStates: (states) => set((prev) => ({
      sentenceStates: { ...prev.sentenceStates, ...states }
    })),

    clearSentenceStates: () => set({ sentenceStates: {} }),

    setHighlight: (sentenceId, wordIndex, timestampSource) => set({
      highlightedSentenceId: sentenceId,
      highlightedWordIndex: wordIndex,
      highlightTimestampSource: timestampSource ?? null
    }),

    clearHighlight: () => set({
      highlightedSentenceId: null,
      highlightedWordIndex: null,
      highlightTimestampSource: null
    })
  })
);
