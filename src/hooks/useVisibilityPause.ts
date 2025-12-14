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

  useEffect(() => {
    const handleVisibilityChange = () => {
      // If background playback is allowed, don't pause/resume based on visibility
      if (allowBackgroundPlayback) {
        return;
      }

      if (document.hidden) {
        // Tab hidden - pause if playing
        if (isPlaying) {
          wasPlayingBeforeHide.current = true;
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
  }, [isPlaying, setIsPlaying, allowBackgroundPlayback]);
}
