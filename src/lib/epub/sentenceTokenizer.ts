import { Sentence } from './types';

/**
 * Common abbreviations that shouldn't be treated as sentence endings
 */
const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'Ph.D',
  'etc', 'e.g', 'i.e', 'vs', 'Inc', 'Ltd', 'Co', 'Corp',
  'St', 'Ave', 'Blvd', 'Rd', 'No', 'Vol', 'Fig',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/**
 * Tokenize text into sentences using Intl.Segmenter (when available)
 * Falls back to regex-based tokenization
 */
export function tokenizeSentences(
  text: string,
  chapterId: string,
  locale: string = 'en'
): Sentence[] {
  // Try to use Intl.Segmenter if available (modern browsers)
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return tokenizeWithSegmenter(text, chapterId, locale);
  }

  // Fallback to regex-based tokenization
  return tokenizeWithRegex(text, chapterId);
}

/**
 * Tokenize using Intl.Segmenter (best for internationalization)
 */
function tokenizeWithSegmenter(
  text: string,
  chapterId: string,
  locale: string
): Sentence[] {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const segments = segmenter.segment(text);

  const sentences: Sentence[] = [];
  let index = 0;

  for (const segment of segments) {
    const sentenceText = segment.segment.trim();
    if (sentenceText.length > 0) {
      sentences.push({
        id: `${chapterId}-s${index}`,
        text: sentenceText,
        startIndex: segment.index,
        endIndex: segment.index + segment.segment.length,
        chapterId
      });
      index++;
    }
  }

  return sentences;
}

/**
 * Tokenize using regex (fallback for browsers without Intl.Segmenter)
 */
function tokenizeWithRegex(text: string, chapterId: string): Sentence[] {
  const sentences: Sentence[] = [];

  // Build abbreviation pattern
  const abbrevPattern = ABBREVIATIONS.map(a => a.replace('.', '\\.')).join('|');

  // Split on sentence boundaries, but not after abbreviations
  // This regex looks for . ! ? followed by space and uppercase letter
  const sentenceRegex = new RegExp(
    `(?<!\\b(?:${abbrevPattern}))(?<=[.!?])\\s+(?=[A-Z"'"])`,
    'g'
  );

  let lastIndex = 0;
  let match;
  let index = 0;

  // Use a simple split approach since lookbehind might not work in all browsers
  const parts = text.split(/(?<=[.!?])\s+/);
  let currentPosition = 0;

  for (const part of parts) {
    const trimmedPart = part.trim();
    if (trimmedPart.length > 0) {
      // Check if this is actually a sentence or just an abbreviation fragment
      const endsWithAbbreviation = ABBREVIATIONS.some(abbr =>
        trimmedPart.endsWith(abbr + '.') || trimmedPart.endsWith(abbr)
      );

      // If it's a short fragment that might be an abbreviation, merge with next
      if (trimmedPart.length < 10 && endsWithAbbreviation && sentences.length > 0) {
        // Merge with previous sentence
        const lastSentence = sentences[sentences.length - 1];
        lastSentence.text += ' ' + trimmedPart;
        lastSentence.endIndex = currentPosition + part.length;
      } else {
        sentences.push({
          id: `${chapterId}-s${index}`,
          text: trimmedPart,
          startIndex: currentPosition,
          endIndex: currentPosition + part.length,
          chapterId
        });
        index++;
      }
    }
    currentPosition += part.length + 1; // +1 for the split character
  }

  return sentences;
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
