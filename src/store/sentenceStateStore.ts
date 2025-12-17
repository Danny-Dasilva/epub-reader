import { create } from 'zustand';
import { useEffect, useState, useRef } from 'react';

// Sentence audio state for visual feedback
export type SentenceAudioState = 'pending' | 'preloading' | 'ready' | 'playing' | 'played' | 'error';

// Timestamp source for highlighting accuracy indicator
export type TimestampSource = 'estimated' | 'asr';

export interface SentenceStateMap {
  [sentenceId: string]: SentenceAudioState;
}

// Highlight state interface (non-reactive)
export interface Highlight {
  sentenceId: string;
  wordIndex: number | null;
  timestampSource: TimestampSource | null;
}

// Type for highlight subscription callbacks
type HighlightListener = (highlight: Highlight) => void;

// ============================================================================
// NON-REACTIVE HIGHLIGHT STATE (Fix 1 & 2)
// ============================================================================
// This state is updated 60x/second during playback and should NOT trigger
// React re-renders. Components can read it via getHighlight() or subscribe
// to updates via subscribeToHighlight() for manual rendering control.
// ============================================================================

let currentHighlight: Highlight = {
  sentenceId: '',
  wordIndex: null,
  timestampSource: null
};

const highlightListeners = new Set<HighlightListener>();

/**
 * Set the current highlight state (non-reactive - no re-renders)
 * Called 60x/second during audio playback with word-level timing
 */
export const setHighlight = (
  sentenceId: string | null,
  wordIndex: number | null,
  timestampSource?: TimestampSource
): void => {
  currentHighlight = {
    sentenceId: sentenceId ?? '',
    wordIndex,
    timestampSource: timestampSource ?? null
  };

  // Notify all subscribers (they can use RAF to batch updates)
  highlightListeners.forEach(fn => fn(currentHighlight));
};

/**
 * Get the current highlight state without subscribing (no re-renders)
 */
export const getHighlight = (): Highlight => currentHighlight;

/**
 * Subscribe to highlight changes
 * Returns unsubscribe function
 *
 * Note: Subscribers are called synchronously on every highlight update.
 * For rendering, consider using requestAnimationFrame to batch updates.
 */
export const subscribeToHighlight = (listener: HighlightListener): (() => void) => {
  highlightListeners.add(listener);
  return () => highlightListeners.delete(listener);
};

/**
 * Clear highlight state
 */
export const clearHighlight = (): void => {
  setHighlight(null, null);
};

// ============================================================================
// NON-REACTIVE AUDIO POSITION STATE
// ============================================================================
// Tracks real-time audio position for smooth timestamp updates.
// Uses cumulative time tracking to avoid backward jumps at sentence boundaries.
// Updated 60x/second during playback via wordChange events.
// ============================================================================

interface AudioPosition {
  cumulativeTime: number;       // Total time of sentences completed before current
  withinSentenceTime: number;   // Current position within sentence (from audio element)
  lastUpdate: number;           // Timestamp of last update (for staleness detection)
}

let audioPosition: AudioPosition = {
  cumulativeTime: 0,
  withinSentenceTime: 0,
  lastUpdate: 0
};

type AudioPositionListener = (position: AudioPosition) => void;
const audioPositionListeners = new Set<AudioPositionListener>();

/**
 * Set the current audio position within the sentence (non-reactive - no re-renders)
 * Called 60x/second during audio playback
 */
export const setAudioPosition = (withinSentenceTime: number): void => {
  audioPosition = {
    ...audioPosition,
    withinSentenceTime,
    lastUpdate: Date.now()
  };

  // Notify all subscribers
  audioPositionListeners.forEach(fn => fn(audioPosition));
};

/**
 * Add completed sentence duration to cumulative time
 * Called when a sentence finishes playing
 */
export const addToPlayedTime = (duration: number): void => {
  audioPosition = {
    ...audioPosition,
    cumulativeTime: audioPosition.cumulativeTime + duration,
    lastUpdate: Date.now()
  };
};

/**
 * Set the cumulative time to a specific value
 * Called when seeking to initialize time based on position
 */
export const setCumulativeTime = (time: number): void => {
  audioPosition = {
    ...audioPosition,
    cumulativeTime: time,
    withinSentenceTime: 0,
    lastUpdate: Date.now()
  };
};

/**
 * Get the current audio position without subscribing
 */
export const getAudioPosition = (): AudioPosition => audioPosition;

/**
 * Subscribe to audio position changes
 * Returns unsubscribe function
 */
export const subscribeToAudioPosition = (listener: AudioPositionListener): (() => void) => {
  audioPositionListeners.add(listener);
  return () => audioPositionListeners.delete(listener);
};

/**
 * Clear audio position state (resets both cumulative and within-sentence time)
 */
export const clearAudioPosition = (): void => {
  audioPosition = { cumulativeTime: 0, withinSentenceTime: 0, lastUpdate: 0 };
};

// ============================================================================
// REACTIVE SENTENCE LIFECYCLE STATE (Zustand Store)
// ============================================================================
// This state changes rarely (pending → preloading → ready → playing → played)
// and it's appropriate to use normal Zustand reactivity for these updates.
// ============================================================================

interface SentenceStateStoreState {
  sentenceStates: SentenceStateMap;
  asrCompletedIds: Set<string>;  // Sentences with ASR-refined timestamps
}

interface SentenceStateStoreActions {
  setSentenceState: (sentenceId: string, state: SentenceAudioState) => void;
  setSentenceStates: (states: Record<string, SentenceAudioState>) => void;
  clearSentenceStates: () => void;
  markASRComplete: (sentenceId: string) => void;
  clearASRCompleted: () => void;
}

export const useSentenceStateStore = create<SentenceStateStoreState & SentenceStateStoreActions>()(
  (set) => ({
    // Initial state (ephemeral - not persisted)
    sentenceStates: {},
    asrCompletedIds: new Set<string>(),

    // Actions
    setSentenceState: (sentenceId, state) => set((prev) => ({
      sentenceStates: { ...prev.sentenceStates, [sentenceId]: state }
    })),

    setSentenceStates: (states) => set((prev) => ({
      sentenceStates: { ...prev.sentenceStates, ...states }
    })),

    clearSentenceStates: () => set({ sentenceStates: {} }),

    markASRComplete: (sentenceId) => set((prev) => {
      const newSet = new Set(prev.asrCompletedIds);
      newSet.add(sentenceId);
      return { asrCompletedIds: newSet };
    }),

    clearASRCompleted: () => set({ asrCompletedIds: new Set<string>() })
  })
);

// ============================================================================
// OPTIMIZATION #5: DEBOUNCED TIMELINE STATE HOOK
// ============================================================================
// During preloading, sentence states update every 50-200ms causing continuous
// Timeline re-renders. This hook debounces updates to reduce render frequency
// while still providing responsive visual feedback.
// ============================================================================

/**
 * Debounced hook for Timeline sentence states
 * Reduces re-renders from ~20/sec to ~6/sec during active preloading
 */
export const useDebouncedSentenceStates = (debounceMs = 150): SentenceStateMap => {
  const [debouncedStates, setDebouncedStates] = useState<SentenceStateMap>(() =>
    useSentenceStateStore.getState().sentenceStates
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestStatesRef = useRef<SentenceStateMap>(debouncedStates);

  useEffect(() => {
    const unsubscribe = useSentenceStateStore.subscribe((state) => {
      latestStatesRef.current = state.sentenceStates;

      // Clear any pending timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Debounce the state update
      timeoutRef.current = setTimeout(() => {
        setDebouncedStates(latestStatesRef.current);
        timeoutRef.current = null;
      }, debounceMs);
    });

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      unsubscribe();
    };
  }, [debounceMs]);

  return debouncedStates;
};
