/**
 * Text extraction and cleaning utilities
 * Adapted from EPUB-TTS/epub2tts.py
 */

const BLACKLIST_TAGS = [
  'noscript', 'header', 'head', 'meta', 'input', 'script', 'style', 'nav', 'footer'
];

const DASH_ELLIPSES_PATTERN = /--|—|–|;|:|''| \. \. \. |\.\.\. |…/g;
const SMART_APOSTROPHE_PATTERN = /['']/g;
const SMART_QUOTES_PATTERN = /[""«»]/g;
const SPECIAL_CHARS_PATTERN = /[◇\[\]]/g;
const ASTERISK_PATTERN = /\*/g;
const AMPERSAND_PATTERN = /&/g;
const NEWLINE_PATTERN = /\n/g;
const PUNCTUATION_SPACING_PATTERN = / ([,\.!\?])/g;
const WHITESPACE_PATTERN = /\s+/g;
const FOOTNOTE_LINK_PATTERN = /^[\d\[\]()]+$/;
const FOOTNOTE_BRACKET_PATTERN = /^\[?\d+\]?$/;
const FOOTNOTE_NUMBER_PATTERN = /^\d+$/;

/**
 * Clean text for TTS processing
 * Adapted from prep_text() in epub2tts.py lines 171-195
 * Optimized: Combined regex operations to reduce string passes
 */
export function cleanText(text: string): string {
  return text
    .replace(DASH_ELLIPSES_PATTERN, ', ')
    .replace(SMART_APOSTROPHE_PATTERN, "'")
    .replace(SMART_QUOTES_PATTERN, '"')
    .replace(SPECIAL_CHARS_PATTERN, '')
    .replace(ASTERISK_PATTERN, ' ')
    .replace(AMPERSAND_PATTERN, ' and ')
    .replace(NEWLINE_PATTERN, ' ')
    .replace(PUNCTUATION_SPACING_PATTERN, '$1')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

/**
 * Extract plain text from HTML document
 */
export function extractTextFromHTML(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  BLACKLIST_TAGS.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  });

  doc.querySelectorAll('a[href]').forEach(a => {
    const text = a.textContent || '';
    if (FOOTNOTE_LINK_PATTERN.test(text.trim()) || FOOTNOTE_BRACKET_PATTERN.test(text.trim())) {
      a.remove();
    }
  });

  doc.querySelectorAll('sup').forEach(sup => {
    const text = sup.textContent || '';
    if (FOOTNOTE_NUMBER_PATTERN.test(text.trim())) {
      sup.remove();
    }
  });

  const text = doc.body.textContent || '';

  return cleanText(text);
}

/**
 * Extract text from a chapter, preserving paragraph structure
 */
export function extractChapterText(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  BLACKLIST_TAGS.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  });

  doc.querySelectorAll('a[href]').forEach(a => {
    const text = a.textContent || '';
    if (FOOTNOTE_LINK_PATTERN.test(text.trim())) {
      a.remove();
    }
  });

  const paragraphElements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, blockquote');
  const paragraphs: string[] = [];

  paragraphElements.forEach(el => {
    const text = (el.textContent || '').trim();
    if (text.length > 0) {
      paragraphs.push(cleanText(text));
    }
  });

  if (paragraphs.length === 0) {
    return cleanText(doc.body.textContent || '');
  }

  return paragraphs.join('\n\n');
}

const NUMERIC_ONLY_PATTERN = /^\d+$/;
const TITLE_WHITESPACE_PATTERN = /\s+/g;
const TITLE_NEWLINE_PATTERN = /\n/g;

/**
 * Extract chapter title from HTML content by looking at heading tags.
 * Tries tags in priority order: title, h1, h2, h3
 * Returns null if no suitable title is found.
 */
export function extractChapterTitleFromHTML(html: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const titleTags = ['title', 'h1', 'h2', 'h3'];

  for (const tag of titleTags) {
    const element = doc.querySelector(tag);
    if (element?.textContent?.trim()) {
      const title = element.textContent.trim();
      if (!NUMERIC_ONLY_PATTERN.test(title) && title.length > 0) {
        return title
          .replace(TITLE_WHITESPACE_PATTERN, ' ')
          .replace(TITLE_NEWLINE_PATTERN, ' ')
          .trim();
      }
    }
  }

  return null;
}

const ROMAN_NUMERAL_PATTERN = /\b(I{1,3}|IV|V|VI{0,3}|IX|X{1,2}|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX)\b/g;

const romanMap: Record<string, string> = {
  'I': 'one', 'II': 'two', 'III': 'three', 'IV': 'four', 'V': 'five',
  'VI': 'six', 'VII': 'seven', 'VIII': 'eight', 'IX': 'nine', 'X': 'ten',
  'XI': 'eleven', 'XII': 'twelve', 'XIII': 'thirteen', 'XIV': 'fourteen',
  'XV': 'fifteen', 'XVI': 'sixteen', 'XVII': 'seventeen', 'XVIII': 'eighteen',
  'XIX': 'nineteen', 'XX': 'twenty'
};

/**
 * Remove Roman numerals from text (convert to words)
 */
export function convertRomanNumerals(text: string): string {
  return text.replace(ROMAN_NUMERAL_PATTERN, (match) => {
    return romanMap[match] || match;
  });
}
