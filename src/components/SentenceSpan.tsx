'use client';

import { memo, useMemo } from 'react';
import { Sentence, FormattingSpan, FormattingType } from '@/lib/epub';
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

interface WordPart {
  text: string;
  isWhitespace: boolean;
  formatting: Set<FormattingType>;
}

/**
 * Split text into words/whitespace with formatting information
 *
 * Performance optimization #5: Pre-sorted spans with pointer tracking
 * Reduces O(n×m) to O(n+m) where n=text length, m=formatting spans
 */
function splitWordsWithFormatting(
  text: string,
  formattingSpans: FormattingSpan[] = []
): WordPart[] {
  // Split into words and whitespace first
  const parts = text.split(/(\s+)/).filter(Boolean);
  if (formattingSpans.length === 0) {
    // Fast path: no formatting, skip all span processing
    return parts.map(part => ({
      text: part,
      isWhitespace: part.trim().length === 0,
      formatting: new Set<FormattingType>()
    }));
  }

  // Performance optimization #5: Sort spans by startIndex once (O(m log m))
  const sortedSpans = [...formattingSpans].sort((a, b) => a.startIndex - b.startIndex);

  const result: WordPart[] = [];
  let currentPos = 0;
  let spanIdx = 0;
  const activeSpans: FormattingSpan[] = [];

  for (const part of parts) {
    const isWhitespace = part.trim().length === 0;
    const partEnd = currentPos + part.length;
    const formatting = new Set<FormattingType>();

    // Add spans that start before or at this part's end
    while (spanIdx < sortedSpans.length && sortedSpans[spanIdx].startIndex < partEnd) {
      activeSpans.push(sortedSpans[spanIdx]);
      spanIdx++;
    }

    // Check which active spans overlap with this part and collect their types
    for (let i = activeSpans.length - 1; i >= 0; i--) {
      const span = activeSpans[i];
      // Remove spans that ended before this part
      if (span.endIndex <= currentPos) {
        activeSpans.splice(i, 1);
      } else if (span.startIndex < partEnd && span.endIndex > currentPos) {
        // Span overlaps with this part
        formatting.add(span.type);
      }
    }

    result.push({ text: part, isWhitespace, formatting });
    currentPos = partEnd;
  }

  return result;
}

/**
 * Get CSS class string for formatting
 */
function getFormattingClass(formatting: Set<FormattingType>): string {
  const classes: string[] = [];
  if (formatting.has('italic')) classes.push('format-italic');
  if (formatting.has('bold')) classes.push('format-bold');
  if (formatting.has('underline')) classes.push('format-underline');
  return classes.join(' ');
}

/**
 * Memoized sentence component with word-level highlighting and formatting.
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
  // Memoize word splitting with formatting - only recompute when text or formatting changes
  const wordParts = useMemo(() => {
    return splitWordsWithFormatting(sentence.text, sentence.formatting);
  }, [sentence.text, sentence.formatting]);

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

  // Memoize the ASR class suffix to avoid string concatenation on every word
  const asrClassSuffix = useMemo(() => {
    return timestampSource === 'asr' ? ' asr-accurate' : '';
  }, [timestampSource]);

  // Memoize word class computation function
  // - spoken: already read (gray)
  // - speaking: currently being read (highlighted)
  // - asr-accurate: using accurate ASR timestamps (green highlight instead of yellow)
  // - (no extra class): upcoming words (normal)
  const getWordClass = useMemo(() => {
    if (!isHighlighted || highlightedWordIndex === null) {
      return () => 'word';
    }

    return (wordIdx: number): string => {
      if (wordIdx < highlightedWordIndex) return 'word spoken' + asrClassSuffix;
      if (wordIdx === highlightedWordIndex) return 'word speaking' + asrClassSuffix;
      return 'word';
    };
  }, [isHighlighted, highlightedWordIndex, asrClassSuffix]);

  // Track word index for highlighting (only count non-whitespace parts)
  let wordIndex = 0;

  return (
    <span
      id={`sentence-${index}`}
      onClick={onClick}
      className={`sentence cursor-pointer inline ${stateClass} ${isHighlighted ? 'active' : ''}`}
    >
      {wordParts.map((part, partIndex) => {
        if (part.isWhitespace) {
          // Whitespace - render as-is
          return <span key={partIndex}>{part.text}</span>;
        }

        // Word - determine class based on position and formatting
        const currentWordIndex = wordIndex;
        wordIndex++;

        const wordClass = getWordClass(currentWordIndex);
        const formatClass = getFormattingClass(part.formatting);

        return (
          <span
            key={partIndex}
            className={`${wordClass} ${formatClass}`.trim()}
          >
            {part.text}
          </span>
        );
      })}
      {/* Add space after sentence for natural reading flow */}
      {' '}
    </span>
  );
}, (prevProps, nextProps) => {
  // Custom equality function for memo - return true if props are equal (should NOT re-render)
  // Only re-render if these specific props change
  return (
    prevProps.sentence.id === nextProps.sentence.id &&
    prevProps.sentence.text === nextProps.sentence.text &&
    prevProps.sentence.formatting === nextProps.sentence.formatting &&
    prevProps.index === nextProps.index &&
    prevProps.state === nextProps.state &&
    prevProps.isHighlighted === nextProps.isHighlighted &&
    prevProps.highlightedWordIndex === nextProps.highlightedWordIndex &&
    prevProps.timestampSource === nextProps.timestampSource
    // Note: onClick is intentionally excluded as it's typically a stable reference
  );
});
