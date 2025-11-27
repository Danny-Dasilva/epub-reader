'use client';

import { useEffect, useCallback } from 'react';
import { usePlaybackStore } from '@/store/playbackStore';
import { useNavigationStore } from '@/store/navigationStore';
import { useUIStore, Theme } from '@/store/uiStore';

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

interface KeyboardShortcutHandlers {
  onSkipBack?: () => void;
  onSkipForward?: () => void;
}

/**
 * Hook that provides keyboard shortcuts for the reader.
 *
 * Shortcuts:
 * - Space: Play/Pause
 * - Left Arrow: Skip back ~15 seconds
 * - Right Arrow: Skip forward ~15 seconds
 * - Up Arrow: Previous sentence
 * - Down Arrow: Next sentence
 * - [ : Decrease speed
 * - ] : Increase speed
 * - M : Toggle mute
 * - T : Cycle theme
 * - Escape : Close settings
 */
export function useKeyboardShortcuts(handlers?: KeyboardShortcutHandlers) {
  // Playback store
  const isPlaying = usePlaybackStore(state => state.isPlaying);
  const setIsPlaying = usePlaybackStore(state => state.setIsPlaying);
  const audioPlaybackRate = usePlaybackStore(state => state.audioPlaybackRate);
  const setAudioPlaybackRate = usePlaybackStore(state => state.setAudioPlaybackRate);
  const volume = usePlaybackStore(state => state.volume);
  const setVolume = usePlaybackStore(state => state.setVolume);

  // Navigation store
  const nextSentence = useNavigationStore(state => state.nextSentence);
  const prevSentence = useNavigationStore(state => state.prevSentence);

  // UI store
  const theme = useUIStore(state => state.theme);
  const setTheme = useUIStore(state => state.setTheme);
  const showSettings = useUIStore(state => state.showSettings);
  const setShowSettings = useUIStore(state => state.setShowSettings);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore if typing in an input or textarea
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target as HTMLElement)?.isContentEditable
    ) {
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        setIsPlaying(!isPlaying);
        break;

      case 'ArrowLeft':
        e.preventDefault();
        handlers?.onSkipBack?.();
        break;

      case 'ArrowRight':
        e.preventDefault();
        handlers?.onSkipForward?.();
        break;

      case 'ArrowUp':
        e.preventDefault();
        prevSentence();
        break;

      case 'ArrowDown':
        e.preventDefault();
        nextSentence();
        break;

      case '[':
        e.preventDefault();
        const currentIdx = SPEED_OPTIONS.indexOf(audioPlaybackRate);
        if (currentIdx > 0) {
          setAudioPlaybackRate(SPEED_OPTIONS[currentIdx - 1]);
        }
        break;

      case ']':
        e.preventDefault();
        const curIdx = SPEED_OPTIONS.indexOf(audioPlaybackRate);
        if (curIdx < SPEED_OPTIONS.length - 1) {
          setAudioPlaybackRate(SPEED_OPTIONS[curIdx + 1]);
        }
        break;

      case 'm':
      case 'M':
        e.preventDefault();
        setVolume(volume > 0 ? 0 : 1);
        break;

      case 't':
      case 'T':
        e.preventDefault();
        const themes: Theme[] = ['sepia', 'light', 'dark'];
        const themeIdx = themes.indexOf(theme);
        setTheme(themes[(themeIdx + 1) % themes.length]);
        break;

      case 'Escape':
        if (showSettings) {
          e.preventDefault();
          setShowSettings(false);
        }
        break;
    }
  }, [
    isPlaying,
    setIsPlaying,
    audioPlaybackRate,
    setAudioPlaybackRate,
    volume,
    setVolume,
    theme,
    setTheme,
    showSettings,
    setShowSettings,
    nextSentence,
    prevSentence,
    handlers
  ]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
