'use client';

import { useEffect, useRef } from 'react';
import { usePlaybackStore } from '@/store/playbackStore';

/**
 * Hook that automatically pauses audio when the tab becomes hidden
 * and resumes when it becomes visible again (if it was playing before).
 * This is expected behavior for audiobook-style applications.
 */
export function useVisibilityPause() {
  const isPlaying = usePlaybackStore(state => state.isPlaying);
  const setIsPlaying = usePlaybackStore(state => state.setIsPlaying);
  const wasPlayingBeforeHide = useRef(false);

  useEffect(() => {
    const handleVisibilityChange = () => {
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
  }, [isPlaying, setIsPlaying]);
}
