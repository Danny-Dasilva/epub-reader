import { ParsedBook, Chapter, Sentence } from './types';
import { PaginationData, getPageForSentence } from './pagination';

/**
 * Search result representing a match in the book
 */
export interface SearchResult {
  chapterIndex: number;
  chapterTitle: string;
  sentenceIndex: number;
  sentenceId: string;
  text: string;
  matchStart: number;
  matchEnd: number;
  pageNumber: number;
  totalPages: number;
}

/**
 * Search through all sentences in a book for a query string.
 * Performs case-insensitive substring matching.
 *
 * @param book - The parsed book to search
 * @param query - The search query (min 2 characters)
 * @param pagination - Optional pagination data for page numbers
 * @param maxResults - Maximum number of results to return (default 50)
 * @returns Array of search results sorted by position in book
 */
export function searchBook(
  book: ParsedBook,
  query: string,
  pagination?: PaginationData | null,
  maxResults: number = 50
): SearchResult[] {
  const results: SearchResult[] = [];

  // Minimum query length
  if (!query || query.length < 2) {
    return results;
  }

  const normalizedQuery = query.toLowerCase().trim();

  for (let chapterIndex = 0; chapterIndex < book.chapters.length; chapterIndex++) {
    const chapter = book.chapters[chapterIndex];

    for (let sentenceIndex = 0; sentenceIndex < chapter.sentences.length; sentenceIndex++) {
      const sentence = chapter.sentences[sentenceIndex];
      const normalizedText = sentence.text.toLowerCase();

      // Find all matches in this sentence
      let searchIndex = 0;
      while (true) {
        const matchStart = normalizedText.indexOf(normalizedQuery, searchIndex);
        if (matchStart === -1) break;

        // Get page info if pagination data is available
        const pageInfo = pagination
          ? getPageForSentence(pagination, chapterIndex, sentenceIndex)
          : { pageNumber: 0, totalPages: 0 };

        results.push({
          chapterIndex,
          chapterTitle: chapter.title,
          sentenceIndex,
          sentenceId: sentence.id,
          text: sentence.text,
          matchStart,
          matchEnd: matchStart + query.length,
          pageNumber: pageInfo.pageNumber,
          totalPages: pageInfo.totalPages
        });

        // Move past this match to find more in the same sentence
        searchIndex = matchStart + 1;

        // Stop if we have enough results
        if (results.length >= maxResults) {
          return results;
        }
      }
    }
  }

  return results;
}

/**
 * Get context around a search match for display
 *
 * @param text - Full sentence text
 * @param matchStart - Start index of match
 * @param matchEnd - End index of match
 * @param contextChars - Number of characters to show around match
 * @returns Object with prefix, match, and suffix
 */
export function getMatchContext(
  text: string,
  matchStart: number,
  matchEnd: number,
  contextChars: number = 30
): { prefix: string; match: string; suffix: string } {
  const prefix = text.slice(Math.max(0, matchStart - contextChars), matchStart);
  const match = text.slice(matchStart, matchEnd);
  const suffix = text.slice(matchEnd, matchEnd + contextChars);

  return {
    prefix: matchStart > contextChars ? '...' + prefix : prefix,
    match,
    suffix: matchEnd + contextChars < text.length ? suffix + '...' : suffix
  };
}

/**
 * Count total matches for a query in a book (without returning full results)
 * Useful for showing "X matches found" without loading all results
 */
export function countMatches(book: ParsedBook, query: string): number {
  if (!query || query.length < 2) {
    return 0;
  }

  const normalizedQuery = query.toLowerCase().trim();
  let count = 0;

  for (const chapter of book.chapters) {
    for (const sentence of chapter.sentences) {
      const normalizedText = sentence.text.toLowerCase();
      let searchIndex = 0;

      while (true) {
        const matchStart = normalizedText.indexOf(normalizedQuery, searchIndex);
        if (matchStart === -1) break;
        count++;
        searchIndex = matchStart + 1;
      }
    }
  }

  return count;
}
