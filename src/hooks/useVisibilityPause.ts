'use client';

import { useEffect } from 'react';
import { usePlaybackStore } from '@/store/playbackStore';

/**
 * Hook that automatically pauses audio when the tab becomes hidden
 * and resumes when it becomes visible again (if it was playing before).
 *
 * If `allowBackgroundPlayback` is enabled, this behavior is disabled
 * and audio continues playing in the background.
 */
export function useVisibilityPause() {
  const setIsPlaying = usePlaybackStore(state => state.setIsPlaying);

  useEffect(() => {
    let resumeOnVisible = false;
    let changingVisibilityPlayback = false;
    const unsubscribe = usePlaybackStore.subscribe((state, previous) => {
      // Any subsequent playback change supersedes the automatic pause, even if
      // React batches both changes before an effect can observe them.
      if (!changingVisibilityPlayback && state.isPlaying !== previous.isPlaying) {
        resumeOnVisible = false;
      }
      if (state.allowBackgroundPlayback && !previous.allowBackgroundPlayback) {
        resumeOnVisible = false;
      }
    });
    const handleVisibilityChange = () => {
      // Read at event time to avoid re-registering listener on setting change
      const { allowBackgroundPlayback } = usePlaybackStore.getState();
      if (allowBackgroundPlayback) {
        resumeOnVisible = false;
        return;
      }

      if (document.hidden) {
        // Tab hidden - pause if playing
        // Use getState() to get current value, not stale closure value
        const currentlyPlaying = usePlaybackStore.getState().isPlaying;
        if (currentlyPlaying) {
          resumeOnVisible = true;
          changingVisibilityPlayback = true;
          setIsPlaying(false);
          changingVisibilityPlayback = false;
        }
      } else {
        // Tab visible - resume if was playing before
        if (resumeOnVisible) {
          resumeOnVisible = false;
          setIsPlaying(true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [setIsPlaying]);
}
