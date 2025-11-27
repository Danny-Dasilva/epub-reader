/**
 * Text extraction and cleaning utilities
 * Adapted from EPUB-TTS/epub2tts.py
 */

// HTML tags to remove (blacklist from epub2tts.py)
const BLACKLIST_TAGS = [
  'noscript', 'header', 'head', 'meta', 'input', 'script', 'style', 'nav', 'footer'
];

/**
 * Clean text for TTS processing
 * Adapted from prep_text() in epub2tts.py lines 171-195
 */
export function cleanText(text: string): string {
  let cleaned = text
    // Replace dashes and symbols
    .replace(/--/g, ', ')
    .replace(/—/g, ', ')
    .replace(/–/g, ', ')
    .replace(/;/g, ', ')
    .replace(/:/g, ', ')
    .replace(/''/g, ', ')
    // Normalize quotes
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/"/g, '"')
    .replace(/"/g, '"')
    .replace(/«/g, '"')
    .replace(/»/g, '"')
    // Remove special chars
    .replace(/◇/g, '')
    .replace(/\[/g, '')
    .replace(/\]/g, '')
    .replace(/\*/g, ' ')
    // Handle ellipses
    .replace(/ \. \. \. /g, ', ')
    .replace(/\.\.\. /g, ', ')
    .replace(/…/g, ', ')
    // Replace ampersand
    .replace(/&/g, ' and ')
    // Normalize newlines
    .replace(/\n/g, ' ')
    // Fix spacing around punctuation
    .replace(/ ,/g, ',')
    .replace(/ \./g, '.')
    .replace(/ !/g, '!')
    .replace(/ \?/g, '?')
    // Remove extra spaces
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

/**
 * Extract plain text from HTML document
 */
export function extractTextFromHTML(html: string): string {
  // Create a temporary DOM element
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove blacklisted elements
  BLACKLIST_TAGS.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  });

  // Remove footnote links (links that are just numbers)
  doc.querySelectorAll('a[href]').forEach(a => {
    const text = a.textContent || '';
    // Remove if it's just numbers or common footnote patterns
    if (/^[\d\[\]()]+$/.test(text.trim()) || /^\[?\d+\]?$/.test(text.trim())) {
      a.remove();
    }
  });

  // Remove superscript numbers (usually footnotes)
  doc.querySelectorAll('sup').forEach(sup => {
    const text = sup.textContent || '';
    if (/^\d+$/.test(text.trim())) {
      sup.remove();
    }
  });

  // Get text content
  const text = doc.body.textContent || '';

  return cleanText(text);
}

/**
 * Extract text from a chapter, preserving paragraph structure
 */
export function extractChapterText(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove blacklisted elements
  BLACKLIST_TAGS.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  });

  // Remove footnote links
  doc.querySelectorAll('a[href]').forEach(a => {
    const text = a.textContent || '';
    if (/^[\d\[\]()]+$/.test(text.trim())) {
      a.remove();
    }
  });

  // Get all paragraph-like elements
  const paragraphElements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, blockquote');
  const paragraphs: string[] = [];

  paragraphElements.forEach(el => {
    const text = (el.textContent || '').trim();
    if (text.length > 0) {
      paragraphs.push(cleanText(text));
    }
  });

  // If no paragraphs found, fall back to body text
  if (paragraphs.length === 0) {
    return cleanText(doc.body.textContent || '');
  }

  return paragraphs.join('\n\n');
}

/**
 * Remove Roman numerals from text (convert to words)
 */
export function convertRomanNumerals(text: string): string {
  const romanMap: Record<string, string> = {
    'I': 'one', 'II': 'two', 'III': 'three', 'IV': 'four', 'V': 'five',
    'VI': 'six', 'VII': 'seven', 'VIII': 'eight', 'IX': 'nine', 'X': 'ten',
    'XI': 'eleven', 'XII': 'twelve', 'XIII': 'thirteen', 'XIV': 'fourteen',
    'XV': 'fifteen', 'XVI': 'sixteen', 'XVII': 'seventeen', 'XVIII': 'eighteen',
    'XIX': 'nineteen', 'XX': 'twenty'
  };

  // Only convert standalone Roman numerals (chapter numbers, etc.)
  return text.replace(/\b(I{1,3}|IV|V|VI{0,3}|IX|X{1,2}|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX)\b/g, (match) => {
    return romanMap[match] || match;
  });
}
