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
// NON-REACTIVE HIGHLIGHT STATE (Performance optimization #2)
// ============================================================================
// This state is updated 60x/second during playback and should NOT trigger
// React re-renders. Components can read it via getHighlight() or subscribe
// to updates via subscribeToHighlight() for manual rendering control.
//
// Performance optimization #2: Single subscriber pattern
// Instead of iterating a Map of listeners on every update (60x/sec),
// we use a single callback with identity check for O(1) operations.
// ============================================================================

let currentHighlight: Highlight = {
  sentenceId: '',
  wordIndex: null,
  timestampSource: null
};

// Performance optimization #2: Single callback instead of Map iteration
let highlightCallback: HighlightListener | null = null;

/**
 * Set the current highlight state (non-reactive - no re-renders)
 * Called 60x/second during audio playback with word-level timing
 *
 * Performance optimization #2 & #9: Skip if unchanged (identity check)
 */
export const setHighlight = (
  sentenceId: string | null,
  wordIndex: number | null,
  timestampSource?: TimestampSource
): void => {
  const newSentenceId = sentenceId ?? '';
  const newTimestampSource = timestampSource ?? null;

  // Performance optimization #9: Skip if unchanged (reduces downstream work)
  if (
    currentHighlight.sentenceId === newSentenceId &&
    currentHighlight.wordIndex === wordIndex &&
    currentHighlight.timestampSource === newTimestampSource
  ) {
    return;
  }

  currentHighlight = {
    sentenceId: newSentenceId,
    wordIndex,
    timestampSource: newTimestampSource
  };

  // Notify single subscriber (O(1) instead of forEach iteration)
  highlightCallback?.(currentHighlight);
};

/**
 * Get the current highlight state without subscribing (no re-renders)
 */
export const getHighlight = (): Highlight => currentHighlight;

/**
 * Subscribe to highlight changes
 * Returns unsubscribe function
 *
 * Performance optimization #2: Single subscriber pattern
 * Only one component should subscribe at a time (typically the reader page).
 * This eliminates Map iteration overhead on every frame.
 *
 * Note: The subscriber is called synchronously on every highlight update.
 * For rendering, consider using requestAnimationFrame to batch updates.
 */
export const subscribeToHighlight = (listener: HighlightListener): (() => void) => {
  // Replace any existing listener (single subscriber pattern)
  highlightCallback = listener;

  return () => {
    // Only clear if this is still the active listener
    if (highlightCallback === listener) {
      highlightCallback = null;
    }
  };
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
// PERFORMANCE OPTIMIZATION #7: RAF-COALESCED TIMELINE STATE HOOK
// ============================================================================
// During preloading, sentence states update every 50-200ms causing continuous
// Timeline re-renders. This hook coalesces updates using requestAnimationFrame
// for immediate visual feedback at display refresh rate (no arbitrary delay).
// ============================================================================

/**
 * RAF-coalesced hook for Timeline sentence states
 * Updates at display refresh rate instead of arbitrary debounce delay
 *
 * Performance optimization #7: Replaces 150ms debounce with RAF coalescing
 * - Immediate visual feedback (no delay)
 * - Natural 60fps cap from RAF
 * - Multiple state updates within a frame are coalesced into one render
 */
export const useDebouncedSentenceStates = (_debounceMs = 150): SentenceStateMap => {
  const [coalescedStates, setCoalescedStates] = useState<SentenceStateMap>(() =>
    useSentenceStateStore.getState().sentenceStates
  );
  const rafRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const latestStatesRef = useRef<SentenceStateMap>(coalescedStates);

  useEffect(() => {
    const unsubscribe = useSentenceStateStore.subscribe((state) => {
      latestStatesRef.current = state.sentenceStates;
      dirtyRef.current = true;

      // Schedule RAF update if not already scheduled
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          if (dirtyRef.current) {
            setCoalescedStates(latestStatesRef.current);
            dirtyRef.current = false;
          }
          rafRef.current = null;
        });
      }
    });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      unsubscribe();
    };
  }, []);

  return coalescedStates;
};
