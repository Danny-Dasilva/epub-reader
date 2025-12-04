import tokenizer from 'sbd';
import { Sentence } from './types';

/**
 * Tokenize text into sentences using the sbd (Sentence Boundary Detection) library.
 * This library handles abbreviations like "Dr.", "M.D.", "etc." correctly
 * without splitting them as separate sentences.
 */
export function tokenizeSentences(
  text: string,
  chapterId: string,
  locale: string = 'en'
): Sentence[] {
  const options = {
    newline_boundaries: true,  // Treat newlines as sentence boundaries
    html_boundaries: false,    // Don't treat HTML tags as boundaries
    sanitize: false,           // Keep original text
    allowed_tags: false,       // No tag filtering
  };

  const sentenceTexts = tokenizer.sentences(text, options);
  let currentIndex = 0;

  return sentenceTexts
    .filter(s => s.trim().length > 0)
    .map((sentenceText, index) => {
      const trimmed = sentenceText.trim();
      const startIndex = text.indexOf(trimmed, currentIndex);
      currentIndex = startIndex + trimmed.length;

      return {
        id: `${chapterId}-s${index}`,
        text: trimmed,
        startIndex: startIndex >= 0 ? startIndex : currentIndex,
        endIndex: startIndex >= 0 ? startIndex + trimmed.length : currentIndex + trimmed.length,
        chapterId
      };
    });
}

/**
 * Split long sentences for better TTS processing
 * Sentences longer than maxLength will be split at natural break points
 */
export function splitLongSentences(
  sentences: Sentence[],
  maxLength: number = 200
): Sentence[] {
  const result: Sentence[] = [];

  for (const sentence of sentences) {
    if (sentence.text.length <= maxLength) {
      result.push(sentence);
    } else {
      // Split at comma, semicolon, or em-dash
      const parts = splitAtBreakPoints(sentence.text, maxLength);
      let offset = sentence.startIndex;

      parts.forEach((part, i) => {
        result.push({
          id: `${sentence.id}-${i}`,
          text: part.trim(),
          startIndex: offset,
          endIndex: offset + part.length,
          chapterId: sentence.chapterId
        });
        offset += part.length;
      });
    }
  }

  return result;
}

/**
 * Split text at natural break points (commas, semicolons, etc.)
 */
function splitAtBreakPoints(text: string, maxLength: number): string[] {
  const result: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Find the best split point within maxLength
    let splitIndex = -1;

    // Look for comma, semicolon, or dash
    for (let i = Math.min(maxLength, remaining.length) - 1; i >= maxLength / 2; i--) {
      const char = remaining[i];
      if (char === ',' || char === ';' || char === '-' || char === ':') {
        splitIndex = i + 1;
        break;
      }
    }

    // If no good split point, split at space
    if (splitIndex === -1) {
      for (let i = Math.min(maxLength, remaining.length) - 1; i >= maxLength / 2; i--) {
        if (remaining[i] === ' ') {
          splitIndex = i + 1;
          break;
        }
      }
    }

    // If still no split point, force split at maxLength
    if (splitIndex === -1) {
      splitIndex = maxLength;
    }

    result.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length > 0) {
    result.push(remaining);
  }

  return result;
}

/**
 * Get word count for a sentence (for timing estimation)
 */
export function getWordCount(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Estimate speaking duration based on word count
 * Average speaking rate is about 150 words per minute
 */
export function estimateDuration(text: string, wordsPerMinute: number = 150): number {
  const words = getWordCount(text);
  return (words / wordsPerMinute) * 60; // Returns seconds
}
