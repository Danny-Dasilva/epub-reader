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

export interface Sentence {
  id: string;
  text: string;
  startIndex: number;     // Character position in plainText
  endIndex: number;
  chapterId: string;
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
