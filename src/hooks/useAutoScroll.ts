'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useUIStore, ScrollPosition } from '@/store/uiStore';

interface UseAutoScrollOptions {
  currentSentenceIndex: number | null;
  isPlaying: boolean;
  containerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Hook for auto-scrolling to the current sentence during playback.
 *
 * Features:
 * - Scrolls to current sentence using 'top' or 'center' positioning
 * - Temporarily disables on manual scroll
 * - Re-enables when playback resumes after pause
 */
export function useAutoScroll({
  currentSentenceIndex,
  isPlaying,
  containerRef
}: UseAutoScrollOptions) {
  const autoScroll = useUIStore((state) => state.autoScroll);
  const scrollPosition = useUIStore((state) => state.scrollPosition);
  const setAutoScroll = useUIStore((state) => state.setAutoScroll);

  // Track if user has manually scrolled (temporarily disables auto-scroll)
  const userScrolledRef = useRef(false);
  const lastSentenceIndexRef = useRef<number | null>(null);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Scroll to a sentence element
  const scrollToSentence = useCallback((index: number, position: ScrollPosition) => {
    const element = document.getElementById(`sentence-${index}`);
    if (element) {
      element.scrollIntoView({
        behavior: 'smooth',
        block: position === 'top' ? 'start' : 'center',
        inline: 'nearest'
      });
    }
  }, []);

  // Handle manual scroll detection
  useEffect(() => {
    const container = containerRef?.current || window;

    const handleScroll = () => {
      // If we're in the middle of an auto-scroll, ignore this event
      if (scrollTimeoutRef.current) {
        return;
      }

      // User manually scrolled - temporarily disable auto-scroll
      if (isPlaying && autoScroll) {
        userScrolledRef.current = true;
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef, isPlaying, autoScroll]);

  // Re-enable auto-scroll when playback resumes from pause
  useEffect(() => {
    if (isPlaying && userScrolledRef.current) {
      // Give user a moment, then re-enable auto-scroll
      const timeout = setTimeout(() => {
        userScrolledRef.current = false;
      }, 2000);
      return () => clearTimeout(timeout);
    }
  }, [isPlaying]);

  // Auto-scroll when sentence changes
  useEffect(() => {
    if (
      currentSentenceIndex !== null &&
      currentSentenceIndex !== lastSentenceIndexRef.current &&
      autoScroll &&
      isPlaying &&
      !userScrolledRef.current
    ) {
      // Set a flag to ignore the scroll event we're about to trigger
      scrollTimeoutRef.current = setTimeout(() => {
        scrollTimeoutRef.current = null;
      }, 500);

      scrollToSentence(currentSentenceIndex, scrollPosition);
      lastSentenceIndexRef.current = currentSentenceIndex;
    }
  }, [currentSentenceIndex, autoScroll, scrollPosition, isPlaying, scrollToSentence]);

  // Expose manual scroll function for external use
  const scrollTo = useCallback((index: number) => {
    scrollToSentence(index, scrollPosition);
  }, [scrollToSentence, scrollPosition]);

  return {
    scrollTo,
    isAutoScrollEnabled: autoScroll && !userScrolledRef.current,
  };
}
