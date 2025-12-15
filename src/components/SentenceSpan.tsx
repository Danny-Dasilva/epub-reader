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
 */
function splitWordsWithFormatting(
  text: string,
  formattingSpans: FormattingSpan[] = []
): WordPart[] {
  // Build character-to-formatting lookup for efficiency
  const charFormatting: Array<Set<FormattingType>> = [];
  for (let i = 0; i < text.length; i++) {
    const formats = new Set<FormattingType>();
    for (const span of formattingSpans) {
      if (i >= span.startIndex && i < span.endIndex) {
        formats.add(span.type);
      }
    }
    charFormatting.push(formats);
  }

  // Split into words and whitespace
  const parts = text.split(/(\s+)/).filter(Boolean);
  const result: WordPart[] = [];
  let currentPos = 0;

  for (const part of parts) {
    const isWhitespace = part.trim().length === 0;

    // Collect all formatting that applies to any character in this part
    const formatting = new Set<FormattingType>();
    for (let i = currentPos; i < currentPos + part.length && i < charFormatting.length; i++) {
      charFormatting[i].forEach(f => formatting.add(f));
    }

    result.push({ text: part, isWhitespace, formatting });
    currentPos += part.length;
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
