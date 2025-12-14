/**
 * Text Preprocessing for TTS
 * Normalizes text before synthesis by removing emojis, replacing symbols, etc.
 * This can be done at EPUB parsing time to avoid repeated preprocessing during synthesis.
 */

/**
 * Preprocess text for TTS
 * Normalizes text, removes emojis, replaces symbols, etc.
 */
export function preprocessText(text: string): string {
  // Normalize text
  text = text.normalize('NFKD');

  // Remove emojis
  const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
  text = text.replace(emojiPattern, '');

  // Replace dashes and symbols
  const replacements: Record<string, string> = {
    '–': '-', '‑': '-', '—': '-', '¯': ' ', '_': ' ',
    '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
    '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ',
    '#': ' ', '→': ' ', '←': ' ',
  };
  for (const [k, v] of Object.entries(replacements)) {
    text = text.replaceAll(k, v);
  }

  // Remove diacritics
  text = text.replace(/[\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F]/g, '');

  // Remove special symbols
  text = text.replace(/[♥☆♡©\\]/g, '');

  // Replace expressions
  text = text.replaceAll('@', ' at ');
  text = text.replaceAll('e.g.,', 'for example, ');
  text = text.replaceAll('i.e.,', 'that is, ');

  // Fix spacing
  text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!')
    .replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");

  // Remove duplicate quotes
  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");

  // Clean whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Add period if needed
  if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(text)) {
    text += '.';
  }

  return text;
}
