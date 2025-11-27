'use client';

import { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import { Sentence } from '@/lib/epub';
import { SentenceAudioState, SentenceStateMap } from '@/store/readerStore';
import { SentenceSpan } from './SentenceSpan';

interface VirtualizedSentenceListProps {
  sentences: Sentence[];
  sentenceStates: SentenceStateMap;
  currentIndex: number;
  highlightedSentenceId: string | null;
  highlightedWordIndex: number | null;
  onSentenceClick: (index: number) => void;
  isPlaying: boolean;
}

// Buffer of sentences to render above/below viewport
const BUFFER_SIZE = 20;

// Estimated height per sentence for initial calculation
const ESTIMATED_SENTENCE_HEIGHT = 28;

/**
 * Virtualized sentence list that only renders visible sentences.
 * Uses IntersectionObserver to track which sentences are in view.
 */
export function VirtualizedSentenceList({
  sentences,
  sentenceStates,
  currentIndex,
  highlightedSentenceId,
  highlightedWordIndex,
  onSentenceClick,
  isPlaying
}: VirtualizedSentenceListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: Math.min(50, sentences.length) });

  // Update visible range based on scroll position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateVisibleRange = () => {
      const scrollTop = container.scrollTop || 0;
      const containerHeight = container.clientHeight || window.innerHeight;

      // Find parent scrollable element
      let scrollableParent = container.parentElement;
      while (scrollableParent && scrollableParent.scrollHeight <= scrollableParent.clientHeight) {
        scrollableParent = scrollableParent.parentElement;
      }

      const actualScrollTop = scrollableParent?.scrollTop || scrollTop;
      const actualHeight = scrollableParent?.clientHeight || containerHeight;

      // Estimate which sentences are visible
      const startIndex = Math.max(0, Math.floor(actualScrollTop / ESTIMATED_SENTENCE_HEIGHT) - BUFFER_SIZE);
      const visibleCount = Math.ceil(actualHeight / ESTIMATED_SENTENCE_HEIGHT) + BUFFER_SIZE * 2;
      const endIndex = Math.min(sentences.length, startIndex + visibleCount);

      setVisibleRange(prev => {
        // Only update if there's a meaningful change
        if (Math.abs(prev.start - startIndex) > 5 || Math.abs(prev.end - endIndex) > 5) {
          return { start: startIndex, end: endIndex };
        }
        return prev;
      });
    };

    // Initial update
    updateVisibleRange();

    // Listen to scroll events on parent
    let scrollableParent = container.parentElement;
    while (scrollableParent && scrollableParent.scrollHeight <= scrollableParent.clientHeight) {
      scrollableParent = scrollableParent.parentElement;
    }

    const scrollTarget = scrollableParent || window;
    scrollTarget.addEventListener('scroll', updateVisibleRange, { passive: true });

    return () => {
      scrollTarget.removeEventListener('scroll', updateVisibleRange);
    };
  }, [sentences.length]);

  // Ensure current sentence is always in visible range when playing
  useEffect(() => {
    if (isPlaying) {
      setVisibleRange(prev => {
        const expandedStart = Math.max(0, Math.min(prev.start, currentIndex - BUFFER_SIZE));
        const expandedEnd = Math.min(sentences.length, Math.max(prev.end, currentIndex + BUFFER_SIZE));
        if (expandedStart !== prev.start || expandedEnd !== prev.end) {
          return { start: expandedStart, end: expandedEnd };
        }
        return prev;
      });
    }
  }, [currentIndex, isPlaying, sentences.length]);

  // Get visible sentences
  const visibleSentences = useMemo(() => {
    return sentences.slice(visibleRange.start, visibleRange.end).map((sentence, i) => ({
      sentence,
      index: visibleRange.start + i
    }));
  }, [sentences, visibleRange.start, visibleRange.end]);

  // Handle sentence click
  const handleClick = useCallback((index: number) => {
    onSentenceClick(index);
  }, [onSentenceClick]);

  // For short lists, just render everything
  if (sentences.length <= 100) {
    return (
      <div ref={containerRef} className="space-y-1 leading-relaxed">
        {sentences.map((sentence, index) => {
          const isActive = highlightedSentenceId === sentence.id ||
            (isPlaying && index === currentIndex);
          const state = sentenceStates[sentence.id];

          return (
            <SentenceSpan
              key={sentence.id}
              sentence={sentence}
              index={index}
              state={state}
              isHighlighted={isActive}
              highlightedWordIndex={isActive ? highlightedWordIndex : null}
              onClick={() => handleClick(index)}
            />
          );
        })}
      </div>
    );
  }

  // For long lists, use virtualization
  return (
    <div ref={containerRef} className="space-y-1 leading-relaxed">
      {/* Spacer for sentences before visible range */}
      {visibleRange.start > 0 && (
        <div
          style={{ height: visibleRange.start * ESTIMATED_SENTENCE_HEIGHT }}
          aria-hidden="true"
        />
      )}

      {/* Visible sentences */}
      {visibleSentences.map(({ sentence, index }) => {
        const isActive = highlightedSentenceId === sentence.id ||
          (isPlaying && index === currentIndex);
        const state = sentenceStates[sentence.id];

        return (
          <SentenceSpan
            key={sentence.id}
            sentence={sentence}
            index={index}
            state={state}
            isHighlighted={isActive}
            highlightedWordIndex={isActive ? highlightedWordIndex : null}
            onClick={() => handleClick(index)}
          />
        );
      })}

      {/* Spacer for sentences after visible range */}
      {visibleRange.end < sentences.length && (
        <div
          style={{ height: (sentences.length - visibleRange.end) * ESTIMATED_SENTENCE_HEIGHT }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
