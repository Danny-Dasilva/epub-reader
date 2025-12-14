'use client';

import { useEffect, useCallback } from 'react';
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
  const {
    onPlay,
    onPause,
    onNextSentence,
    onPrevSentence,
    onSeekForward,
    onSeekBackward
  } = options;

  const isPlaying = usePlaybackStore(state => state.isPlaying);
  const setIsPlaying = usePlaybackStore(state => state.setIsPlaying);
  const allowBackgroundPlayback = usePlaybackStore(state => state.allowBackgroundPlayback);

  const currentBook = useNavigationStore(state => state.currentBook);
  const currentChapterIndex = useNavigationStore(state => state.currentChapterIndex);

  // Handle play action
  const handlePlay = useCallback(() => {
    if (onPlay) {
      onPlay();
    } else {
      setIsPlaying(true);
    }
  }, [onPlay, setIsPlaying]);

  // Handle pause action
  const handlePause = useCallback(() => {
    if (onPause) {
      onPause();
    } else {
      setIsPlaying(false);
    }
  }, [onPause, setIsPlaying]);

  // Update metadata when book/chapter changes
  useEffect(() => {
    // Only setup Media Session if background playback is allowed
    // and the API is available
    if (!allowBackgroundPlayback || !('mediaSession' in navigator)) {
      return;
    }

    if (!currentBook) {
      return;
    }

    const currentChapter = currentBook.chapters[currentChapterIndex];
    if (!currentChapter) {
      return;
    }

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
    if (!allowBackgroundPlayback || !('mediaSession' in navigator)) {
      return;
    }

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying, allowBackgroundPlayback]);

  // Set up action handlers
  useEffect(() => {
    if (!allowBackgroundPlayback || !('mediaSession' in navigator)) {
      return;
    }

    // Play/Pause
    navigator.mediaSession.setActionHandler('play', handlePlay);
    navigator.mediaSession.setActionHandler('pause', handlePause);

    // Next/Previous (sentence navigation)
    if (onNextSentence) {
      navigator.mediaSession.setActionHandler('nexttrack', onNextSentence);
    }
    if (onPrevSentence) {
      navigator.mediaSession.setActionHandler('previoustrack', onPrevSentence);
    }

    // Seek forward/backward (15 second skip)
    if (onSeekForward) {
      navigator.mediaSession.setActionHandler('seekforward', onSeekForward);
    }
    if (onSeekBackward) {
      navigator.mediaSession.setActionHandler('seekbackward', onSeekBackward);
    }

    return () => {
      // Clean up handlers
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
  }, [
    allowBackgroundPlayback,
    handlePlay,
    handlePause,
    onNextSentence,
    onPrevSentence,
    onSeekForward,
    onSeekBackward
  ]);
}
