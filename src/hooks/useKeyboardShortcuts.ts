'use client';

import { useEffect, useRef } from 'react';
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
  // Store handlers in ref to avoid re-registering the keydown listener
  // when the parent re-renders with a new handlers object reference
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input or textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      switch (e.key) {
        case ' ': {
          e.preventDefault();
          const { isPlaying, setIsPlaying } = usePlaybackStore.getState();
          setIsPlaying(!isPlaying);
          break;
        }

        case 'ArrowLeft':
          e.preventDefault();
          handlersRef.current?.onSkipBack?.();
          break;

        case 'ArrowRight':
          e.preventDefault();
          handlersRef.current?.onSkipForward?.();
          break;

        case 'ArrowUp':
          e.preventDefault();
          useNavigationStore.getState().prevSentence();
          break;

        case 'ArrowDown':
          e.preventDefault();
          useNavigationStore.getState().nextSentence();
          break;

        case '[': {
          e.preventDefault();
          const { audioPlaybackRate, setAudioPlaybackRate } = usePlaybackStore.getState();
          const currentIdx = SPEED_OPTIONS.indexOf(audioPlaybackRate);
          if (currentIdx > 0) {
            setAudioPlaybackRate(SPEED_OPTIONS[currentIdx - 1]);
          }
          break;
        }

        case ']': {
          e.preventDefault();
          const { audioPlaybackRate, setAudioPlaybackRate } = usePlaybackStore.getState();
          const curIdx = SPEED_OPTIONS.indexOf(audioPlaybackRate);
          if (curIdx < SPEED_OPTIONS.length - 1) {
            setAudioPlaybackRate(SPEED_OPTIONS[curIdx + 1]);
          }
          break;
        }

        case 'm':
        case 'M': {
          e.preventDefault();
          const { volume, setVolume } = usePlaybackStore.getState();
          setVolume(volume > 0 ? 0 : 1);
          break;
        }

        case 't':
        case 'T': {
          e.preventDefault();
          const { theme, setTheme } = useUIStore.getState();
          const themes: Theme[] = ['sepia', 'light', 'dark'];
          const themeIdx = themes.indexOf(theme);
          setTheme(themes[(themeIdx + 1) % themes.length]);
          break;
        }

        case 'Escape': {
          const { showSettings, setShowSettings } = useUIStore.getState();
          if (showSettings) {
            e.preventDefault();
            setShowSettings(false);
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);  // Stable - reads handlers from ref
}
