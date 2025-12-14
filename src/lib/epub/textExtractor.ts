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
 * Optimized: Combined regex operations to reduce string passes
 */
export function cleanText(text: string): string {
  return text
    // Combined: Replace dashes, semicolons, colons, double quotes, ellipses → comma
    .replace(/--|—|–|;|:|''| \. \. \. |\.\.\. |…/g, ', ')
    // Combined: Normalize smart quotes (apostrophes)
    .replace(/['']/g, "'")
    // Combined: Normalize smart quotes (double quotes)
    .replace(/[""«»]/g, '"')
    // Combined: Remove special chars (◇, [, ])
    .replace(/[◇\[\]]/g, '')
    // Replace asterisk with space
    .replace(/\*/g, ' ')
    // Replace ampersand
    .replace(/&/g, ' and ')
    // Normalize newlines
    .replace(/\n/g, ' ')
    // Combined: Fix spacing around punctuation
    .replace(/ ([,\.!\?])/g, '$1')
    // Remove extra spaces
    .replace(/\s+/g, ' ')
    .trim();
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
 * Extract chapter title from HTML content by looking at heading tags.
 * Tries tags in priority order: title, h1, h2, h3
 * Returns null if no suitable title is found.
 */
export function extractChapterTitleFromHTML(html: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Try tags in priority order (like epub_to_audiobook approach)
  const titleTags = ['title', 'h1', 'h2', 'h3'];

  for (const tag of titleTags) {
    const element = doc.querySelector(tag);
    if (element?.textContent?.trim()) {
      const title = element.textContent.trim();
      // Skip if it's just a number (like "1" or "12") or empty after cleaning
      if (!/^\d+$/.test(title) && title.length > 0) {
        // Clean the title but preserve more than the body text cleaner does
        return title
          .replace(/\s+/g, ' ')  // Normalize whitespace
          .replace(/\n/g, ' ')   // Remove newlines
          .trim();
      }
    }
  }

  return null;
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
