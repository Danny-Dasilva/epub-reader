/**
 * Text Preprocessing for TTS
 * Normalizes text before synthesis by removing emojis, replacing symbols, etc.
 * This can be done at EPUB parsing time to avoid repeated preprocessing during synthesis.
 */

const EMOJI_PATTERN = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
const DIACRITICS_PATTERN = /[\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F]/g;
const SPECIAL_SYMBOLS_PATTERN = /[♥☆♡©\\]/g;
const ENDING_PUNCTUATION_PATTERN = /[.!?;:,'\"')\]}…。」』】〉》›»]$/;

// Hoisted: punctuation spacing patterns (avoid re-creation per call)
const SPACE_BEFORE_COMMA = / ,/g;
const SPACE_BEFORE_PERIOD = / \./g;
const SPACE_BEFORE_EXCLAIM = / !/g;
const SPACE_BEFORE_QUESTION = / \?/g;
const SPACE_BEFORE_SEMI = / ;/g;
const SPACE_BEFORE_COLON = / :/g;
const SPACE_BEFORE_APOS = / '/g;
const DOUBLE_QUOTE_PATTERN = /""/g;
const DOUBLE_APOS_PATTERN = /''/g;
const WHITESPACE_COLLAPSE = /\s+/g;

// Hoisted: character replacement map (avoid object allocation per call)
const REPLACEMENTS: ReadonlyArray<[string, string]> = [
  ['–', '-'], ['‑', '-'], ['—', '-'], ['¯', ' '], ['_', ' '],
  ['\u201C', '"'], ['\u201D', '"'], ['\u2018', "'"], ['\u2019', "'"],
  ['´', "'"], ['`', "'"], ['[', ' '], [']', ' '], ['|', ' '], ['/', ' '],
  ['#', ' '], ['→', ' '], ['←', ' '],
];

/**
 * Preprocess text for TTS
 * Normalizes text, removes emojis, replaces symbols, etc.
 */
export function preprocessText(text: string): string {
  text = text.normalize('NFKD');
  text = text.replace(EMOJI_PATTERN, '');

  for (const [k, v] of REPLACEMENTS) {
    text = text.replaceAll(k, v);
  }

  text = text.replace(DIACRITICS_PATTERN, '');
  text = text.replace(SPECIAL_SYMBOLS_PATTERN, '');

  text = text.replaceAll('@', ' at ');
  text = text.replaceAll('e.g.,', 'for example, ');
  text = text.replaceAll('i.e.,', 'that is, ');

  text = text.replace(SPACE_BEFORE_COMMA, ',').replace(SPACE_BEFORE_PERIOD, '.')
    .replace(SPACE_BEFORE_EXCLAIM, '!').replace(SPACE_BEFORE_QUESTION, '?')
    .replace(SPACE_BEFORE_SEMI, ';').replace(SPACE_BEFORE_COLON, ':')
    .replace(SPACE_BEFORE_APOS, "'");

  text = text.replace(DOUBLE_QUOTE_PATTERN, '"');
  text = text.replace(DOUBLE_APOS_PATTERN, "'");

  text = text.replace(WHITESPACE_COLLAPSE, ' ').trim();

  if (!ENDING_PUNCTUATION_PATTERN.test(text)) {
    text += '.';
  }

  return text;
}
