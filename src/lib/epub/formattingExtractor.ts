/**
 * Formatting-aware text extraction from HTML
 * Extracts plain text while preserving formatting and block structure metadata
 */

import { FormattingSpan, FormattingType, BlockBoundary, BlockType } from './types';

const DASH_ELLIPSES_PATTERN = /--|—|–|;|:|''| \. \. \. |\.\.\. |…/g;
const SMART_APOSTROPHE_PATTERN = /['']/g;
const SMART_QUOTES_PATTERN = /[""«»]/g;
const SPECIAL_CHARS_PATTERN = /[◇\[\]]/g;
const ASTERISK_PATTERN = /\*/g;
const AMPERSAND_PATTERN = /&/g;
const NEWLINE_PATTERN = /\n/g;
const PUNCTUATION_SPACING_PATTERN = / ([,\.!\?])/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * Clean text while preserving boundary whitespace
 * Unlike cleanText() from textExtractor, this doesn't trim leading/trailing spaces
 * which is important for proper word separation when concatenating text nodes
 */
function cleanTextPreserveWhitespace(text: string): string {
  const hadLeadingSpace = LEADING_WHITESPACE_PATTERN.test(text);
  const hadTrailingSpace = TRAILING_WHITESPACE_PATTERN.test(text);

  let cleaned = text
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

  if (hadLeadingSpace && cleaned.length > 0) {
    cleaned = ' ' + cleaned;
  }
  if (hadTrailingSpace && cleaned.length > 0 && !cleaned.endsWith(' ')) {
    cleaned = cleaned + ' ';
  }

  return cleaned;
}

const BLACKLIST_TAGS = new Set([
  'noscript', 'header', 'head', 'meta', 'input', 'script', 'style', 'nav', 'footer'
]);

const FORMATTING_TAGS: Record<string, FormattingType> = {
  'em': 'italic',
  'i': 'italic',
  'strong': 'bold',
  'b': 'bold',
  'u': 'underline',
};

const BLOCK_TAGS: Record<string, BlockType> = {
  'p': 'paragraph',
  'div': 'paragraph',
  'li': 'list-item',
  'blockquote': 'blockquote',
  'h1': 'heading',
  'h2': 'heading',
  'h3': 'heading',
  'h4': 'heading',
  'h5': 'heading',
  'h6': 'heading',
};

const HEADING_LEVEL_PATTERN = /^h(\d)$/i;
const FOOTNOTE_LINK_PATTERN = /^[\d\[\]()]+$/;
const FOOTNOTE_NUMBER_PATTERN = /^\d+$/;
const LEADING_WHITESPACE_PATTERN = /^\s/;
const TRAILING_WHITESPACE_PATTERN = /\s$/;
const WORD_CHAR_START_PATTERN = /^[\w'''"]/;

/**
 * A raw inline-image reference captured during text extraction.
 * `href` is the chapter-relative path from the XHTML (img@src or SVG image@xlink:href);
 * `charIndex` is the position in the (pre-trim) plain text where the image occurs,
 * used to interleave the image with the surrounding sentences at render time.
 */
export interface RawImageRef {
  href: string;
  alt: string;
  charIndex: number;
}

export interface ExtractionResult {
  plainText: string;
  formattingSpans: FormattingSpan[];
  blockBoundaries: BlockBoundary[];
  images: RawImageRef[];
}

interface ExtractorState {
  text: string;
  formattingSpans: FormattingSpan[];
  blockBoundaries: BlockBoundary[];
  images: RawImageRef[];
  activeFormatting: Map<FormattingType, number>;  // type -> start position
  currentBlock: {
    type: BlockType;
    level?: number;
    startIndex: number;
  } | null;
  position: number;
}

/**
 * Get heading level from tag name
 */
function getHeadingLevel(tagName: string): number {
  const match = tagName.match(HEADING_LEVEL_PATTERN);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * Resolve the source href for an image element.
 * Supports HTML <img src> and SVG <image xlink:href|href>.
 * Skips inline data URIs already present in the markup is unnecessary — they
 * are returned as-is and handled downstream.
 */
function getImageHref(el: Element): string | null {
  const src =
    el.getAttribute('src') ||
    el.getAttribute('xlink:href') ||
    // SVG <image> in XHTML parsed as HTML may expose href without the xlink prefix
    el.getAttribute('href');
  if (!src) return null;
  const trimmed = src.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Check if node should be skipped
 */
function shouldSkipNode(node: Node): boolean {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const tagName = el.tagName.toLowerCase();

    if (BLACKLIST_TAGS.has(tagName)) return true;

    if (tagName === 'a') {
      const text = el.textContent || '';
      if (FOOTNOTE_LINK_PATTERN.test(text.trim())) return true;
    }

    if (tagName === 'sup') {
      const text = el.textContent || '';
      if (FOOTNOTE_NUMBER_PATTERN.test(text.trim())) return true;
    }
  }

  return false;
}

/**
 * Process a single node in the DOM tree
 */
function processNode(node: Node, state: ExtractorState): void {
  if (shouldSkipNode(node)) return;

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    const cleaned = cleanTextPreserveWhitespace(text);

    if (cleaned.length > 0) {
      // Record formatting spans for this text
      const startPos = state.position;

      // Add the cleaned text
      state.text += cleaned;
      state.position += cleaned.length;

      // Create formatting spans for all active formatting
      for (const [type] of state.activeFormatting) {
        // We'll close these when the formatting ends
        // For now, record that this text has this formatting
        state.formattingSpans.push({
          startIndex: startPos,
          endIndex: state.position,
          type
        });
      }
    }
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const tagName = el.tagName.toLowerCase();

  // Inline images: record their position so they can be rendered interleaved
  // with sentences. They contribute NO text (so TTS/sentence tokenization is
  // unaffected) but we remember where they appeared in the text stream.
  // Handles both HTML <img> and SVG <image xlink:href="...">.
  if (tagName === 'img' || tagName === 'image') {
    const href = getImageHref(el);
    if (href) {
      state.images.push({
        href,
        alt: el.getAttribute('alt') || el.getAttribute('aria-label') || '',
        charIndex: state.position
      });
    }
    // <img> has no text children; SVG <image> has none either. Do not recurse.
    return;
  }

  // Check if this is a formatting tag
  const formattingType = FORMATTING_TAGS[tagName];
  if (formattingType) {
    state.activeFormatting.set(formattingType, state.position);
  }

  // Check if this is a block tag
  const blockType = BLOCK_TAGS[tagName];
  if (blockType) {
    // Close previous block if any
    if (state.currentBlock && state.position > state.currentBlock.startIndex) {
      state.blockBoundaries.push({
        type: state.currentBlock.type,
        level: state.currentBlock.level,
        startIndex: state.currentBlock.startIndex,
        endIndex: state.position
      });
    }

    // Add paragraph break if there's content before
    if (state.text.length > 0 && !state.text.endsWith('\n\n')) {
      if (state.text.endsWith('\n')) {
        state.text += '\n';
        state.position += 1;
      } else {
        state.text += '\n\n';
        state.position += 2;
      }
    }

    // Start new block
    state.currentBlock = {
      type: blockType,
      level: tagName.startsWith('h') ? getHeadingLevel(tagName) : undefined,
      startIndex: state.position
    };
  }

  // Process children with whitespace normalization between adjacent inline elements
  const children = Array.from(node.childNodes);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const prevChild = i > 0 ? children[i - 1] : null;

    // Check if we need to add whitespace between adjacent inline elements
    // This handles cases like <em>Have</em><em>you</em> which would otherwise concatenate
    if (prevChild && prevChild.nodeType === Node.ELEMENT_NODE && child.nodeType === Node.ELEMENT_NODE) {
      const prevTag = (prevChild as Element).tagName.toLowerCase();
      const currTag = (child as Element).tagName.toLowerCase();

      if (FORMATTING_TAGS[prevTag] && FORMATTING_TAGS[currTag]) {
        if (state.text.length > 0 && !TRAILING_WHITESPACE_PATTERN.test(state.text)) {
          const currText = (child as Element).textContent || '';
          if (currText.length > 0 && WORD_CHAR_START_PATTERN.test(currText)) {
            state.text += ' ';
            state.position += 1;
          }
        }
      }
    }

    if (prevChild && prevChild.nodeType === Node.TEXT_NODE && child.nodeType === Node.ELEMENT_NODE) {
      const currTag = (child as Element).tagName.toLowerCase();
      if (FORMATTING_TAGS[currTag]) {
        const prevText = prevChild.textContent || '';
        const currText = (child as Element).textContent || '';
        if (prevText.length > 0 && !TRAILING_WHITESPACE_PATTERN.test(prevText) &&
            currText.length > 0 && WORD_CHAR_START_PATTERN.test(currText) &&
            state.text.length > 0 && !TRAILING_WHITESPACE_PATTERN.test(state.text)) {
          state.text += ' ';
          state.position += 1;
        }
      }
    }

    processNode(child, state);
  }

  // Close formatting tag
  if (formattingType) {
    state.activeFormatting.delete(formattingType);
  }

  // Close block tag
  if (blockType && state.currentBlock) {
    if (state.position > state.currentBlock.startIndex) {
      state.blockBoundaries.push({
        type: state.currentBlock.type,
        level: state.currentBlock.level,
        startIndex: state.currentBlock.startIndex,
        endIndex: state.position
      });
    }
    state.currentBlock = null;
  }
}

/**
 * Merge overlapping formatting spans of the same type
 */
function mergeFormattingSpans(spans: FormattingSpan[]): FormattingSpan[] {
  if (spans.length === 0) return [];

  // Group by type (js-set-map-lookups: avoid redundant set() when key already present)
  const byType = new Map<FormattingType, FormattingSpan[]>();
  for (const span of spans) {
    const existing = byType.get(span.type);
    if (existing) {
      existing.push(span);
    } else {
      byType.set(span.type, [span]);
    }
  }

  const merged: FormattingSpan[] = [];

  for (const [type, typeSpans] of byType) {
    // Sort by start position without mutating (js-tosorted-immutable)
    const sortedSpans = typeSpans.toSorted((a, b) => a.startIndex - b.startIndex);

    let current: FormattingSpan | null = null;

    for (const span of sortedSpans) {
      if (!current) {
        current = { ...span };
      } else if (span.startIndex <= current.endIndex) {
        // Overlapping or adjacent - extend current
        current.endIndex = Math.max(current.endIndex, span.endIndex);
      } else {
        // Gap - save current and start new
        merged.push(current);
        current = { ...span };
      }
    }

    if (current) {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Extract text with formatting metadata from HTML
 */
export function extractTextWithFormatting(html: string): ExtractionResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const state: ExtractorState = {
    text: '',
    formattingSpans: [],
    blockBoundaries: [],
    images: [],
    activeFormatting: new Map(),
    currentBlock: null,
    position: 0
  };

  // Process the body
  if (doc.body) {
    processNode(doc.body, state);
  }

  // Close any remaining block
  if (state.currentBlock && state.position > state.currentBlock.startIndex) {
    state.blockBoundaries.push({
      type: state.currentBlock.type,
      level: state.currentBlock.level,
      startIndex: state.currentBlock.startIndex,
      endIndex: state.position
    });
  }

  // Merge overlapping formatting spans
  const mergedSpans = mergeFormattingSpans(state.formattingSpans);

  // Clean up trailing whitespace
  const plainText = state.text.trim();

  // Adjust positions if we trimmed leading whitespace
  const leadingTrim = state.text.length - state.text.trimStart().length;
  const adjustedSpans = mergedSpans
    .map(span => ({
      ...span,
      startIndex: Math.max(0, span.startIndex - leadingTrim),
      endIndex: Math.min(plainText.length, span.endIndex - leadingTrim)
    }))
    .filter(span => span.endIndex > span.startIndex);

  const adjustedBlocks = state.blockBoundaries
    .map(block => ({
      ...block,
      startIndex: Math.max(0, block.startIndex - leadingTrim),
      endIndex: Math.min(plainText.length, block.endIndex - leadingTrim)
    }))
    .filter(block => block.endIndex > block.startIndex);

  // Adjust image char positions for the leading-whitespace trim, clamped to
  // the final plainText length so images at the very end map past the last char.
  const adjustedImages = state.images.map(img => ({
    ...img,
    charIndex: Math.min(plainText.length, Math.max(0, img.charIndex - leadingTrim))
  }));

  return {
    plainText,
    formattingSpans: adjustedSpans,
    blockBoundaries: adjustedBlocks,
    images: adjustedImages
  };
}

const NUMERIC_ONLY_PATTERN = /^\d+$/;
const TITLE_WHITESPACE_PATTERN = /\s+/g;
const TITLE_NEWLINE_PATTERN = /\n/g;

/**
 * Extract chapter title from HTML content
 * (Re-exported from original for compatibility)
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
