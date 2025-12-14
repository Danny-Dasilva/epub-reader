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
