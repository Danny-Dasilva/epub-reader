'use client';

import { useCallback } from 'react';
import { Sentence } from '@/lib/epub';
import { SentenceStateMap } from '@/store/sentenceStateStore';
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

/**
 * Sentence list component that renders all sentences.
 * Virtualization removed - chapters are typically small enough that
 * rendering all sentences performs well, and avoids display issues
 * caused by estimated heights not matching actual content.
 */
export function VirtualizedSentenceList({
  sentences,
  sentenceStates,
  highlightedSentenceId,
  highlightedWordIndex,
  onSentenceClick,
}: VirtualizedSentenceListProps) {
  const handleClick = useCallback((index: number) => {
    onSentenceClick(index);
  }, [onSentenceClick]);

  return (
    <div className="leading-relaxed">
      {sentences.map((sentence, index) => {
        const isActive = highlightedSentenceId === sentence.id;
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
