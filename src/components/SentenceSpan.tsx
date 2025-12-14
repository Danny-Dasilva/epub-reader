'use client';

import { memo, useMemo } from 'react';
import { Sentence } from '@/lib/epub';
import { SentenceAudioState, TimestampSource } from '@/store/sentenceStateStore';

interface SentenceSpanProps {
  sentence: Sentence;
  index: number;
  state: SentenceAudioState | undefined;
  isHighlighted: boolean;
  highlightedWordIndex: number | null;
  timestampSource: TimestampSource | null;
  onClick: () => void;
}

/**
 * Memoized sentence component with word-level highlighting.
 * Pre-splits words on mount to avoid re-computation on every render.
 */
export const SentenceSpan = memo(function SentenceSpan({
  sentence,
  index,
  state,
  isHighlighted,
  highlightedWordIndex,
  timestampSource,
  onClick
}: SentenceSpanProps) {
  // Memoize word splitting - only recompute when text changes
  const words = useMemo(() => {
    return sentence.text.split(/(\s+)/).filter(Boolean);
  }, [sentence.text]);

  // Build CSS class based on state
  const stateClass = useMemo(() => {
    switch (state) {
      case 'ready':
        return 'sentence-ready';
      case 'preloading':
        return 'sentence-preloading';
      case 'playing':
        return 'sentence-playing';
      case 'played':
        return 'sentence-played';
      case 'error':
        return 'sentence-error';
      default:
        return '';
    }
  }, [state]);

  // Get word class based on position relative to highlighted word
  // - spoken: already read (gray)
  // - speaking: currently being read (highlighted)
  // - asr-accurate: using accurate ASR timestamps (green highlight instead of yellow)
  // - (no extra class): upcoming words (normal)
  const getWordClass = (wordIdx: number): string => {
    if (!isHighlighted || highlightedWordIndex === null) return 'word';
    const asrClass = timestampSource === 'asr' ? ' asr-accurate' : '';
    if (wordIdx < highlightedWordIndex) return 'word spoken' + asrClass;
    if (wordIdx === highlightedWordIndex) return 'word speaking' + asrClass;
    return 'word';
  };

  // Track word index for highlighting (words are at even indices after split)
  let wordIndex = 0;

  return (
    <span
      id={`sentence-${index}`}
      onClick={onClick}
      className={`sentence cursor-pointer inline ${stateClass} ${isHighlighted ? 'active' : ''}`}
    >
      {words.map((part, partIndex) => {
        // Check if this is a word (non-whitespace) or whitespace
        const isWord = part.trim().length > 0;

        if (!isWord) {
          // Whitespace - render as-is
          return <span key={partIndex}>{part}</span>;
        }

        // Word - determine class based on position (spoken/speaking/upcoming)
        const currentWordIndex = wordIndex;
        wordIndex++;

        return (
          <span
            key={partIndex}
            className={getWordClass(currentWordIndex)}
          >
            {part}
          </span>
        );
      })}
      {/* Add space after sentence for natural reading flow */}
      {' '}
    </span>
  );
});
