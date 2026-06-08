import ePub, { Book, NavItem } from 'epubjs';
import { ParsedBook, Chapter, TOCItem, Sentence } from './types';
import { extractTextWithFormatting, extractChapterTitleFromHTML } from './formattingExtractor';
import { tokenizeSentencesWithFormatting, splitLongSentencesWithFormatting } from './sentenceTokenizer';
import { resolveChapterImages } from './imageExtractor';

/**
 * Generate a unique book ID from metadata
 */
function generateBookId(title: string, author: string): string {
  const combined = `${title}-${author}`.toLowerCase();
  // Simple hash function
  let hash = 0;
  const len = combined.length; // js-cache-property-access: cache .length outside loop
  for (let i = 0; i < len; i++) {
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

    // Load metadata, spine, and navigation in parallel (independent resources)
    const [metadata, spine, navigation] = await Promise.all([
      this.book.loaded.metadata,
      this.book.loaded.spine,
      this.book.loaded.navigation,
    ]);

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

        // Extract text with formatting metadata
        const extracted = extractTextWithFormatting(html);
        const plainText = extracted.plainText;

        // Skip chapters with very little content
        if (plainText.length < 50) continue;

        // Extract chapter title from HTML tags, falling back to spine metadata
        const htmlTitle = extractChapterTitleFromHTML(html);
        const chapterTitle = htmlTitle || this.getChapterTitle(item, i);

        // Create spoken content with title prepended for TTS
        // The title will be read as the first sentence of the chapter
        const titlePrefix = `${chapterTitle}.\n\n`;
        const spokenText = titlePrefix + plainText;

        // Adjust formatting and block positions to account for title prefix
        const titleOffset = titlePrefix.length;
        const { formattingSpans, blockBoundaries } = extracted;
        const adjustedFormatting = formattingSpans.map(span => ({
          ...span,
          startIndex: span.startIndex + titleOffset,
          endIndex: span.endIndex + titleOffset
        }));
        const adjustedBlocks = blockBoundaries.map(block => ({
          ...block,
          startIndex: block.startIndex + titleOffset,
          endIndex: block.endIndex + titleOffset
        }));

        // Tokenize into sentences with formatting metadata
        const chapterId = item.idref || `chapter-${i}`;
        let sentences = tokenizeSentencesWithFormatting(
          spokenText,
          chapterId,
          adjustedFormatting,
          adjustedBlocks
        );

        // Split long sentences for better TTS (preserving formatting)
        sentences = splitLongSentencesWithFormatting(sentences, 200);

        // Resolve inline images to data URLs and position them relative to
        // sentences. Image char positions are shifted by the title prefix so
        // they share the same coordinate space as sentence.startIndex.
        // Images are display-only and excluded from `sentences`/TTS.
        const chapterHref = item.href || '';
        const rawImages = extracted.images.map(img => ({
          ...img,
          charIndex: img.charIndex + titleOffset
        }));
        const images = await resolveChapterImages(
          this.book,
          chapterHref,
          chapterId,
          rawImages,
          sentences
        );

        chapters.push({
          id: chapterId,
          href: chapterHref,
          title: chapterTitle,
          content: html,
          plainText,
          sentences,
          images: images.length > 0 ? images : undefined
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
  // js-combine-iterations: single pass accumulates both totals simultaneously
  let totalSentences = 0;
  let completedSentences = 0;

  for (let i = 0; i < book.chapters.length; i++) {
    const len = book.chapters[i].sentences.length;
    if (i < chapterIndex) {
      completedSentences += len;
    } else if (i === chapterIndex) {
      completedSentences += sentenceIndex;
    }
    totalSentences += len;
  }

  return totalSentences > 0 ? (completedSentences / totalSentences) * 100 : 0;
}
