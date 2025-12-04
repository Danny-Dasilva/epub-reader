import ePub, { Book, NavItem } from 'epubjs';
import { ParsedBook, Chapter, TOCItem, Sentence } from './types';
import { extractChapterText, extractChapterTitleFromHTML } from './textExtractor';
import { tokenizeSentences, splitLongSentences } from './sentenceTokenizer';

/**
 * Generate a unique book ID from metadata
 */
function generateBookId(title: string, author: string): string {
  const combined = `${title}-${author}`.toLowerCase();
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * EPUB Parser class
 * Wraps epub.js for parsing EPUB files
 */
export class EpubParser {
  private book: Book | null = null;

  /**
   * Parse an EPUB file
   */
  async parse(file: File | ArrayBuffer): Promise<ParsedBook> {
    // Load the EPUB
    this.book = ePub(file as ArrayBuffer);
    await this.book.ready;

    // Get metadata
    const metadata = await this.book.loaded.metadata;
    const spine = await this.book.loaded.spine;
    const navigation = await this.book.loaded.navigation;

    // Extract cover
    const cover = await this.extractCover();

    // Extract chapters
    const chapters = await this.extractChapters(spine);

    // Parse table of contents
    const toc = this.parseTOC(navigation.toc);

    return {
      id: generateBookId(metadata.title || 'Unknown', metadata.creator || 'Unknown'),
      title: metadata.title || 'Unknown Title',
      author: metadata.creator || 'Unknown Author',
      cover,
      chapters,
      toc
    };
  }

  /**
   * Extract cover image as data URL
   */
  private async extractCover(): Promise<string | null> {
    if (!this.book) return null;

    try {
      const coverUrl = await this.book.coverUrl();
      if (coverUrl) {
        // Convert to base64 for storage
        const response = await fetch(coverUrl);
        const blob = await response.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      }
    } catch (e) {
      console.warn('Failed to extract cover:', e);
    }

    return null;
  }

  /**
   * Extract all chapters from spine
   */
  private async extractChapters(spine: any): Promise<Chapter[]> {
    if (!this.book) return [];

    const chapters: Chapter[] = [];

    // Get spine items
    const spineItems = spine.items || spine.spineItems || [];

    for (let i = 0; i < spineItems.length; i++) {
      const item = spineItems[i];

      try {
        // Load chapter content
        const section = this.book.spine.get(item.href || item.idref);
        if (!section) continue;

        await section.load(this.book.load.bind(this.book));
        const content = section.contents as unknown as Document;

        if (!content) continue;

        // Handle both Document and Element cases
        const body = 'body' in content ? content.body : content;
        if (!body) continue;

        const html = 'innerHTML' in body ? body.innerHTML : (body as Element).innerHTML;
        const plainText = extractChapterText(html);

        // Skip chapters with very little content
        if (plainText.length < 50) continue;

        // Extract chapter title from HTML tags, falling back to spine metadata
        const htmlTitle = extractChapterTitleFromHTML(html);
        const chapterTitle = htmlTitle || this.getChapterTitle(item, i);

        // Create spoken content with title prepended for TTS
        // The title will be read as the first sentence of the chapter
        const spokenText = `${chapterTitle}.\n\n${plainText}`;

        // Tokenize into sentences (includes title as first sentence)
        const chapterId = item.idref || `chapter-${i}`;
        let sentences = tokenizeSentences(spokenText, chapterId);

        // Split long sentences for better TTS
        sentences = splitLongSentences(sentences, 200);

        chapters.push({
          id: chapterId,
          href: item.href || '',
          title: chapterTitle,
          content: html,
          plainText,
          sentences
        });
      } catch (e) {
        console.warn(`Failed to load chapter ${i}:`, e);
      }
    }

    return chapters;
  }

  /**
   * Get chapter title from spine item or generate one
   */
  private getChapterTitle(item: any, index: number): string {
    if (item.label) return item.label;
    if (item.title) return item.title;
    return `Chapter ${index + 1}`;
  }

  /**
   * Parse navigation/TOC structure
   */
  private parseTOC(navItems: NavItem[]): TOCItem[] {
    return navItems.map((item, index) => ({
      id: item.id || `toc-${index}`,
      href: item.href,
      label: item.label,
      subitems: item.subitems ? this.parseTOC(item.subitems) : undefined
    }));
  }

  /**
   * Destroy the book instance and release resources
   */
  destroy(): void {
    if (this.book) {
      this.book.destroy();
      this.book = null;
    }
  }
}

/**
 * Parse an EPUB file
 * Convenience function that creates a parser, parses, and cleans up
 */
export async function parseEpub(file: File | ArrayBuffer): Promise<ParsedBook> {
  const parser = new EpubParser();
  try {
    return await parser.parse(file);
  } finally {
    parser.destroy();
  }
}

/**
 * Find a chapter by ID
 */
export function findChapterById(book: ParsedBook, chapterId: string): Chapter | undefined {
  return book.chapters.find(ch => ch.id === chapterId);
}

/**
 * Find a sentence by ID
 */
export function findSentenceById(book: ParsedBook, sentenceId: string): Sentence | undefined {
  for (const chapter of book.chapters) {
    const sentence = chapter.sentences.find(s => s.id === sentenceId);
    if (sentence) return sentence;
  }
  return undefined;
}

/**
 * Get total sentence count for a book
 */
export function getTotalSentenceCount(book: ParsedBook): number {
  return book.chapters.reduce((sum, ch) => sum + ch.sentences.length, 0);
}

/**
 * Get reading progress as percentage
 */
export function getReadingProgress(
  book: ParsedBook,
  chapterIndex: number,
  sentenceIndex: number
): number {
  let totalSentences = 0;
  let completedSentences = 0;

  for (let i = 0; i < book.chapters.length; i++) {
    const chapter = book.chapters[i];
    if (i < chapterIndex) {
      completedSentences += chapter.sentences.length;
    } else if (i === chapterIndex) {
      completedSentences += sentenceIndex;
    }
    totalSentences += chapter.sentences.length;
  }

  return totalSentences > 0 ? (completedSentences / totalSentences) * 100 : 0;
}
