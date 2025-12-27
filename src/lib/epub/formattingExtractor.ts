/**
 * Formatting-aware text extraction from HTML
 * Extracts plain text while preserving formatting and block structure metadata
 */

import { FormattingSpan, FormattingType, BlockBoundary, BlockType } from './types';

/**
 * Clean text while preserving boundary whitespace
 * Unlike cleanText() from textExtractor, this doesn't trim leading/trailing spaces
 * which is important for proper word separation when concatenating text nodes
 */
function cleanTextPreserveWhitespace(text: string): string {
  // Check for leading/trailing whitespace before cleaning
  const hadLeadingSpace = /^\s/.test(text);
  const hadTrailingSpace = /\s$/.test(text);

  // Apply all the same transformations as cleanText
  let cleaned = text
    // Replace dashes, semicolons, colons, double quotes, ellipses → comma
    .replace(/--|—|–|;|:|''| \. \. \. |\.\.\. |…/g, ', ')
    // Normalize smart quotes (apostrophes)
    .replace(/['']/g, "'")
    // Normalize smart quotes (double quotes)
    .replace(/[""«»]/g, '"')
    // Remove special chars
    .replace(/[◇\[\]]/g, '')
    // Replace asterisk with space
    .replace(/\*/g, ' ')
    // Replace ampersand
    .replace(/&/g, ' and ')
    // Normalize newlines
    .replace(/\n/g, ' ')
    // Fix spacing around punctuation
    .replace(/ ([,\.!\?])/g, '$1')
    // Normalize multiple spaces to single
    .replace(/\s+/g, ' ')
    // Trim, then restore boundary whitespace
    .trim();

  // Restore single space at boundaries if original had whitespace
  // This preserves word separation when text nodes are concatenated
  if (hadLeadingSpace && cleaned.length > 0) {
    cleaned = ' ' + cleaned;
  }
  if (hadTrailingSpace && cleaned.length > 0 && !cleaned.endsWith(' ')) {
    cleaned = cleaned + ' ';
  }

  return cleaned;
}

// HTML tags to remove (blacklist from epub2tts.py)
const BLACKLIST_TAGS = new Set([
  'noscript', 'header', 'head', 'meta', 'input', 'script', 'style', 'nav', 'footer'
]);

// Inline formatting tags
const FORMATTING_TAGS: Record<string, FormattingType> = {
  'em': 'italic',
  'i': 'italic',
  'strong': 'bold',
  'b': 'bold',
  'u': 'underline',
};

// Block-level tags
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

export interface ExtractionResult {
  plainText: string;
  formattingSpans: FormattingSpan[];
  blockBoundaries: BlockBoundary[];
}

interface ExtractorState {
  text: string;
  formattingSpans: FormattingSpan[];
  blockBoundaries: BlockBoundary[];
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
  const match = tagName.match(/^h(\d)$/i);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * Check if node should be skipped
 */
function shouldSkipNode(node: Node): boolean {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const tagName = el.tagName.toLowerCase();

    // Skip blacklisted tags
    if (BLACKLIST_TAGS.has(tagName)) return true;

    // Skip footnote links (links that are just numbers)
    if (tagName === 'a') {
      const text = el.textContent || '';
      if (/^[\d\[\]()]+$/.test(text.trim())) return true;
    }

    // Skip superscript numbers (usually footnotes)
    if (tagName === 'sup') {
      const text = el.textContent || '';
      if (/^\d+$/.test(text.trim())) return true;
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

      // Both are inline formatting tags with no whitespace between them
      if (FORMATTING_TAGS[prevTag] && FORMATTING_TAGS[currTag]) {
        // Check if text doesn't already end with whitespace
        if (state.text.length > 0 && !/\s$/.test(state.text)) {
          // Check if current element starts with a word character
          const currText = (child as Element).textContent || '';
          if (currText.length > 0 && /^[\w''"]/.test(currText)) {
            state.text += ' ';
            state.position += 1;
          }
        }
      }
    }

    // Also handle case where inline element follows text node that doesn't end with space
    // and the inline element starts a new word
    if (prevChild && prevChild.nodeType === Node.TEXT_NODE && child.nodeType === Node.ELEMENT_NODE) {
      const currTag = (child as Element).tagName.toLowerCase();
      if (FORMATTING_TAGS[currTag]) {
        const prevText = prevChild.textContent || '';
        const currText = (child as Element).textContent || '';
        // If previous text doesn't end with whitespace and current starts with word char
        if (prevText.length > 0 && !/\s$/.test(prevText) &&
            currText.length > 0 && /^[\w]/.test(currText) &&
            state.text.length > 0 && !/\s$/.test(state.text)) {
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

  // Group by type
  const byType = new Map<FormattingType, FormattingSpan[]>();
  for (const span of spans) {
    const existing = byType.get(span.type) || [];
    existing.push(span);
    byType.set(span.type, existing);
  }

  const merged: FormattingSpan[] = [];

  for (const [type, typeSpans] of byType) {
    // Sort by start position
    typeSpans.sort((a, b) => a.startIndex - b.startIndex);

    let current: FormattingSpan | null = null;

    for (const span of typeSpans) {
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

  return {
    plainText,
    formattingSpans: adjustedSpans,
    blockBoundaries: adjustedBlocks
  };
}

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
      if (!/^\d+$/.test(title) && title.length > 0) {
        return title
          .replace(/\s+/g, ' ')
          .replace(/\n/g, ' ')
          .trim();
      }
    }
  }

  return null;
}
