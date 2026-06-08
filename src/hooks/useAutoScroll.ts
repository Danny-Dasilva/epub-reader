'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useUIStore, ScrollPosition } from '@/store/uiStore';

interface UseAutoScrollOptions {
  currentSentenceIndex: number | null;
  isPlaying: boolean;
  containerRef?: React.RefObject<HTMLElement | null>;
}

// Window (ms) after a programmatic scrollIntoView during which scroll events
// are ignored. Must be longer than the browser's smooth-scroll animation
// (~300-600ms) so late animation scroll events aren't mistaken for a manual
// user scroll. See BUG 2.
const AUTO_SCROLL_GUARD_MS = 800;

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

  // Track if user has manually scrolled (temporarily disables auto-scroll)
  const userScrolledRef = useRef(false);
  const lastSentenceIndexRef = useRef<number | null>(null);
  // Timestamp of the last programmatic scroll. Scroll events within
  // AUTO_SCROLL_GUARD_MS of this are ignored (they belong to the smooth-scroll
  // animation, not the user). See BUG 2.
  const lastAutoScrollTimeRef = useRef<number>(0);

  // Use refs for transient values read in the scroll handler
  // to avoid re-registering the scroll listener on every state change
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  // Scroll to a sentence element
  const scrollToSentence = useCallback((index: number, position: ScrollPosition) => {
    const element = document.getElementById(`sentence-${index}`);
    if (element) {
      // Record the time so the scroll handler ignores the animation's events.
      lastAutoScrollTimeRef.current = Date.now();
      element.scrollIntoView({
        behavior: 'smooth',
        block: position === 'top' ? 'start' : 'center',
        inline: 'nearest'
      });
    }
  }, []);

  // Handle manual scroll detection - registered once, reads from refs
  useEffect(() => {
    const container = containerRef?.current || window;

    const handleScroll = () => {
      // Ignore scroll events that belong to a programmatic smooth-scroll
      // animation. The animation can emit events well after the call, so we
      // use a timestamp window rather than a short timeout. See BUG 2.
      if (Date.now() - lastAutoScrollTimeRef.current < AUTO_SCROLL_GUARD_MS) {
        return;
      }

      // User manually scrolled - temporarily disable auto-scroll
      if (isPlayingRef.current && autoScrollRef.current) {
        userScrolledRef.current = true;
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef]);  // Only re-register when container changes

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
      isPlaying
    ) {
      // If the user manually scrolled during the previous sentence, skip the
      // auto-scroll for THIS advance only, then re-engage. This gives a brief
      // pause when the user takes over, while guaranteeing a single stray
      // scroll event can never permanently disable following during continuous
      // playback (the old behavior only re-enabled on a play/pause transition).
      // See BUG 2.
      const skipThisAdvance = userScrolledRef.current;
      userScrolledRef.current = false;
      lastSentenceIndexRef.current = currentSentenceIndex;

      if (!skipThisAdvance) {
        scrollToSentence(currentSentenceIndex, scrollPosition);
      }
    }
  }, [currentSentenceIndex, autoScroll, scrollPosition, isPlaying, scrollToSentence]);

  // Expose manual scroll function for external use (e.g. search-result jumps).
  // Defaults to centering the target sentence so an explicitly-chosen sentence
  // lands in the middle of the viewport. See BUG 4.
  const scrollTo = useCallback((index: number, position: ScrollPosition = 'center') => {
    scrollToSentence(index, position);
  }, [scrollToSentence]);

  return {
    scrollTo,
    isAutoScrollEnabled: autoScroll && !userScrolledRef.current,
  };
}
