import { ParsedBook } from './types';

/**
 * Page information for a specific location
 */
export interface PageInfo {
  pageNumber: number;
  totalPages: number;
}

/**
 * Pagination data for an entire book
 */
export interface PaginationData {
  wordsPerPage: number;
  chapterPages: ChapterPageInfo[];
  totalPages: number;
}

/**
 * Pagination info for a single chapter
 */
export interface ChapterPageInfo {
  chapterId: string;
  chapterIndex: number;
  startPage: number;
  endPage: number;
  pageCount: number;
  sentencePages: number[]; // sentenceIndex -> pageNumber
}

/**
 * Default words per page (industry standard for print books)
 */
const DEFAULT_WORDS_PER_PAGE = 250;

/**
 * Count words in a text string
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

/**
 * Calculate pagination data for an entire book.
 * Maps each sentence to a page number based on cumulative word count.
 *
 * @param book - The parsed book
 * @param wordsPerPage - Words per page (default: 250)
 * @returns Pagination data with page mappings for all chapters
 */
export function calculatePagination(
  book: ParsedBook,
  wordsPerPage: number = DEFAULT_WORDS_PER_PAGE
): PaginationData {
  const chapterPages: ChapterPageInfo[] = [];
  let cumulativeWordCount = 0;
  let currentPage = 1;

  for (let chapterIndex = 0; chapterIndex < book.chapters.length; chapterIndex++) {
    const chapter = book.chapters[chapterIndex];
    const sentencePages: number[] = [];
    const startPage = currentPage;

    for (let sentenceIndex = 0; sentenceIndex < chapter.sentences.length; sentenceIndex++) {
      const sentence = chapter.sentences[sentenceIndex];
      const wordCount = countWords(sentence.text);

      // Assign current page to this sentence
      sentencePages.push(currentPage);

      // Add words and check if we crossed a page boundary
      cumulativeWordCount += wordCount;
      const newPage = Math.floor(cumulativeWordCount / wordsPerPage) + 1;

      if (newPage > currentPage) {
        currentPage = newPage;
      }
    }

    chapterPages.push({
      chapterId: chapter.id,
      chapterIndex,
      startPage,
      endPage: currentPage,
      pageCount: currentPage - startPage + 1,
      sentencePages
    });
  }

  return {
    wordsPerPage,
    chapterPages,
    totalPages: currentPage
  };
}

/**
 * Get page information for a specific sentence.
 *
 * @param pagination - Pre-calculated pagination data
 * @param chapterIndex - Index of the chapter
 * @param sentenceIndex - Index of the sentence within the chapter
 * @returns Page info with page number and total pages
 */
export function getPageForSentence(
  pagination: PaginationData,
  chapterIndex: number,
  sentenceIndex: number
): PageInfo {
  const chapterInfo = pagination.chapterPages[chapterIndex];

  if (!chapterInfo) {
    return { pageNumber: 1, totalPages: pagination.totalPages };
  }

  const pageNumber = chapterInfo.sentencePages[sentenceIndex] ?? chapterInfo.startPage;

  return {
    pageNumber,
    totalPages: pagination.totalPages
  };
}

/**
 * Get page information for a chapter.
 *
 * @param pagination - Pre-calculated pagination data
 * @param chapterIndex - Index of the chapter
 * @returns Chapter page info or null if not found
 */
export function getChapterPageInfo(
  pagination: PaginationData,
  chapterIndex: number
): ChapterPageInfo | null {
  return pagination.chapterPages[chapterIndex] ?? null;
}
