export interface ParsedBook {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  chapters: Chapter[];
  toc: TOCItem[];
}

export interface Chapter {
  id: string;
  href: string;
  title: string;
  content: string;        // Raw HTML
  plainText: string;      // Cleaned text
  sentences: Sentence[];  // Tokenized sentences
  images?: ChapterImage[]; // Inline images, positioned relative to sentences (display-only, not TTS)
}

/**
 * An inline image extracted from chapter XHTML.
 *
 * Images are display-only: they are NOT part of the `sentences` array and are
 * never sent to TTS. They are rendered interleaved with sentences at the
 * correct reading position. `sentenceIndex` is the index in `Chapter.sentences`
 * BEFORE which this image should be rendered (a value equal to sentences.length
 * means "render after the last sentence"). This keeps sentence indices fully
 * contiguous so playback/preload/scroll/search are unaffected.
 */
export interface ChapterImage {
  id: string;
  src: string;            // Resolved URL (data: URL so it survives JSON/IndexedDB round-trip)
  alt: string;            // Alt text from the EPUB, if any
  sentenceIndex: number;  // Render before sentences[sentenceIndex]
}

// Formatting types for rich text rendering
export type FormattingType = 'italic' | 'bold' | 'underline';
export type BlockType = 'paragraph' | 'list-item' | 'blockquote' | 'heading';

export interface FormattingSpan {
  startIndex: number;  // Character position in sentence text
  endIndex: number;
  type: FormattingType;
}

export interface BlockBoundary {
  type: BlockType;
  level?: number;      // For headings (1-6) or list nesting
  startIndex: number;  // Character position in chapter plainText
  endIndex: number;
}

export interface Sentence {
  id: string;
  text: string;
  startIndex: number;     // Character position in plainText
  endIndex: number;
  chapterId: string;
  // Formatting metadata (optional for backward compatibility)
  formatting?: FormattingSpan[];
  blockType?: BlockType;
  blockLevel?: number;
  isBlockStart?: boolean;
  isBlockEnd?: boolean;
  // Preprocessed text for TTS (computed at parse time to avoid repeated preprocessing)
  preprocessedText?: string;
}

export interface TOCItem {
  id: string;
  href: string;
  label: string;
  subitems?: TOCItem[];
}

export interface BookMetadata {
  title: string;
  creator: string;
  language: string;
  identifier: string;
  publisher?: string;
  description?: string;
}

export interface ReadingProgress {
  bookId: string;
  chapterId: string;
  sentenceIndex: number;
  scrollPosition: number;
  lastReadAt: number;
}
