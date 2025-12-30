'use client';

import { useEffect, useRef } from 'react';
import { usePlaybackStore } from '@/store/playbackStore';

/**
 * Hook that automatically pauses audio when the tab becomes hidden
 * and resumes when it becomes visible again (if it was playing before).
 *
 * If `allowBackgroundPlayback` is enabled, this behavior is disabled
 * and audio continues playing in the background.
 */
export function useVisibilityPause() {
  const isPlaying = usePlaybackStore(state => state.isPlaying);
  const setIsPlaying = usePlaybackStore(state => state.setIsPlaying);
  const allowBackgroundPlayback = usePlaybackStore(state => state.allowBackgroundPlayback);
  const wasPlayingBeforeHide = useRef(false);
  // Track if we caused the pause via visibility change
  const pausedByVisibility = useRef(false);

  // Fix #2: Reset wasPlayingBeforeHide when user manually pauses while tab is hidden
  // This prevents incorrect auto-resume when tab becomes visible
  useEffect(() => {
    // If playback stopped and it wasn't caused by visibility change,
    // then the user manually paused - reset the flag
    if (!isPlaying && !pausedByVisibility.current) {
      wasPlayingBeforeHide.current = false;
    }
    // Reset the visibility pause flag after checking
    pausedByVisibility.current = false;
  }, [isPlaying]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      // If background playback is allowed, don't pause/resume based on visibility
      if (allowBackgroundPlayback) {
        return;
      }

      if (document.hidden) {
        // Tab hidden - pause if playing
        // Use getState() to get current value, not stale closure value
        const currentlyPlaying = usePlaybackStore.getState().isPlaying;
        if (currentlyPlaying) {
          wasPlayingBeforeHide.current = true;
          pausedByVisibility.current = true;
          setIsPlaying(false);
        }
      } else {
        // Tab visible - resume if was playing before
        if (wasPlayingBeforeHide.current) {
          wasPlayingBeforeHide.current = false;
          setIsPlaying(true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [setIsPlaying, allowBackgroundPlayback]);
}
