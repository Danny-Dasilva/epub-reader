import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SleepTimerPreset = 5 | 10 | 15 | 30 | 45 | 60 | 'chapter_end';

interface SleepTimerState {
  // State
  isActive: boolean;
  remainingMs: number;
  selectedPreset: SleepTimerPreset | null;
}

interface SleepTimerActions {
  // Actions
  startTimer: (preset: SleepTimerPreset) => void;
  stopTimer: () => void;
  tick: (deltaMs: number) => void;
  reset: () => void;
}

export const useSleepTimerStore = create<SleepTimerState & SleepTimerActions>()(
  persist(
    (set, get) => ({
      // Initial state
      isActive: false,
      remainingMs: 0,
      selectedPreset: null,

      // Actions
      startTimer: (preset) => {
        if (preset === 'chapter_end') {
          // Special mode - doesn't use countdown
          set({
            isActive: true,
            selectedPreset: preset,
            remainingMs: 0
          });
        } else {
          // Convert minutes to milliseconds
          const ms = preset * 60 * 1000;
          set({
            isActive: true,
            selectedPreset: preset,
            remainingMs: ms
          });
        }
      },

      stopTimer: () => {
        set({
          isActive: false,
          remainingMs: 0,
          selectedPreset: null
        });
      },

      tick: (deltaMs) => {
        set((state) => {
          // Don't tick for chapter_end mode
          if (!state.isActive || state.selectedPreset === 'chapter_end') return state;

          // Leave isActive set when this reaches 0. The expiry effect in
          // useSleepTimer keys on `isActive && remainingMs <= 0` to pause
          // playback, then calls stopTimer(). Clearing isActive here meant the
          // expiry never fired and playback kept going.
          return { remainingMs: Math.max(0, state.remainingMs - deltaMs) };
        });
      },

      reset: () => {
        set({
          isActive: false,
          remainingMs: 0,
          selectedPreset: null
        });
      }
    }),
    {
      name: 'epub-reader-sleep-timer',
      partialize: (state) => ({
        // Don't persist active timer state - only the last selected preset for convenience
        selectedPreset: state.selectedPreset
      })
    }
  )
);
