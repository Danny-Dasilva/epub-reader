'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useSleepTimerStore, SleepTimerPreset } from '@/store/sleepTimerStore';

export interface UseSleepTimerOptions {
  onTimerExpired: () => void; // Called to pause playback
  isPlaying: boolean;
  onChapterEnd?: () => void; // For "end of chapter" mode
}

export interface UseSleepTimerReturn {
  isActive: boolean;
  remainingMs: number;
  remainingFormatted: string; // "5:30", "45:00", etc.
  selectedPreset: SleepTimerPreset | null;
  startTimer: (preset: SleepTimerPreset) => void;
  stopTimer: () => void;
}

export function useSleepTimer(options: UseSleepTimerOptions): UseSleepTimerReturn {
  const { onTimerExpired, isPlaying, onChapterEnd } = options;

  // Store state
  const isActive = useSleepTimerStore((state) => state.isActive);
  const remainingMs = useSleepTimerStore((state) => state.remainingMs);
  const selectedPreset = useSleepTimerStore((state) => state.selectedPreset);
  const tick = useSleepTimerStore((state) => state.tick);
  const startTimerStore = useSleepTimerStore((state) => state.startTimer);
  const stopTimerStore = useSleepTimerStore((state) => state.stopTimer);

  // Track last tick time
  const lastTickRef = useRef<number>(Date.now());
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Format remaining time as MM:SS or HH:MM:SS
  const formatTime = useCallback((ms: number): string => {
    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, []);

  const remainingFormatted = selectedPreset === 'chapter_end'
    ? 'Chapter End'
    : formatTime(remainingMs);

  // Start timer wrapper
  const startTimer = useCallback((preset: SleepTimerPreset) => {
    lastTickRef.current = Date.now();
    startTimerStore(preset);
  }, [startTimerStore]);

  // Stop timer wrapper
  const stopTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    stopTimerStore();
  }, [stopTimerStore]);

  // Countdown interval - only runs when playing and active
  useEffect(() => {
    if (!isActive || !isPlaying || selectedPreset === 'chapter_end') {
      // Don't run countdown for chapter_end mode or when paused
      return;
    }

    // Fix #5: Reset lastTickRef when starting a new interval
    // This prevents huge delta values after pause/resume cycles
    lastTickRef.current = Date.now();

    // Start interval
    intervalRef.current = setInterval(() => {
      const now = Date.now();
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;

      tick(delta);
    }, 1000); // Tick every second

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isActive, isPlaying, selectedPreset, tick]);

  // Check if timer has expired
  useEffect(() => {
    if (isActive && remainingMs <= 0 && selectedPreset !== 'chapter_end') {
      // Timer expired - pause playback
      onTimerExpired();
      stopTimer();
    }
  }, [isActive, remainingMs, selectedPreset, onTimerExpired, stopTimer]);

  // Handle chapter end mode - called externally when chapter ends
  useEffect(() => {
    if (isActive && selectedPreset === 'chapter_end' && onChapterEnd) {
      // Chapter end callback is registered but we don't auto-trigger it here
      // The parent component needs to call this when chapter actually ends
    }
  }, [isActive, selectedPreset, onChapterEnd]);

  return {
    isActive,
    remainingMs,
    remainingFormatted,
    selectedPreset,
    startTimer,
    stopTimer
  };
}
