'use client';

import { useEffect, useRef } from 'react';
import { usePlaybackStore } from '@/store/playbackStore';
import { useNavigationStore } from '@/store/navigationStore';

interface UseMediaSessionOptions {
  onPlay?: () => void;
  onPause?: () => void;
  onNextSentence?: () => void;
  onPrevSentence?: () => void;
  onSeekForward?: () => void;
  onSeekBackward?: () => void;
}

/**
 * Hook that integrates with the Media Session API for lock screen controls.
 *
 * Features:
 * - Shows book title, chapter, and cover on lock screen / notification
 * - Play/pause buttons
 * - Next/previous track buttons (mapped to next/prev sentence)
 * - Seek buttons for 15-second skip
 */
export function useMediaSession(options: UseMediaSessionOptions = {}) {
  // Store all callbacks in refs to avoid re-registering media session handlers
  // every time the parent re-renders with new function references
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const isPlaying = usePlaybackStore(state => state.isPlaying);
  const allowBackgroundPlayback = usePlaybackStore(state => state.allowBackgroundPlayback);

  const currentBook = useNavigationStore(state => state.currentBook);
  const currentChapterIndex = useNavigationStore(state => state.currentChapterIndex);

  // Update metadata when book/chapter changes
  useEffect(() => {
    if (!allowBackgroundPlayback || !('mediaSession' in navigator)) return;
    if (!currentBook) return;

    const currentChapter = currentBook.chapters[currentChapterIndex];
    if (!currentChapter) return;

    // Set metadata
    const metadata: MediaMetadataInit = {
      title: currentChapter.title,
      artist: currentBook.author,
      album: currentBook.title,
    };

    // Add cover artwork if available
    if (currentBook.cover) {
      metadata.artwork = [
        { src: currentBook.cover, sizes: '512x512', type: 'image/jpeg' }
      ];
    }

    navigator.mediaSession.metadata = new MediaMetadata(metadata);
  }, [currentBook, currentChapterIndex, allowBackgroundPlayback]);

  // Update playback state
  useEffect(() => {
    if (!allowBackgroundPlayback || !('mediaSession' in navigator)) return;

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying, allowBackgroundPlayback]);

  // Set up action handlers - registered once via refs, no churn on re-renders
  useEffect(() => {
    if (!allowBackgroundPlayback || !('mediaSession' in navigator)) return;

    const { setIsPlaying } = usePlaybackStore.getState();

    // Play/Pause - use refs to always call latest callback
    navigator.mediaSession.setActionHandler('play', () => {
      const { onPlay } = optionsRef.current;
      if (onPlay) { onPlay(); } else { setIsPlaying(true); }
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      const { onPause } = optionsRef.current;
      if (onPause) { onPause(); } else { setIsPlaying(false); }
    });

    // Next/Previous (sentence navigation)
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      optionsRef.current.onNextSentence?.();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      optionsRef.current.onPrevSentence?.();
    });

    // Seek forward/backward (15 second skip)
    navigator.mediaSession.setActionHandler('seekforward', () => {
      optionsRef.current.onSeekForward?.();
    });
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      optionsRef.current.onSeekBackward?.();
    });

    return () => {
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('seekforward', null);
        navigator.mediaSession.setActionHandler('seekbackward', null);
      } catch {
        // Some browsers may not support removing handlers
      }
    };
  }, [allowBackgroundPlayback]);  // Only re-register when background playback toggles
}
