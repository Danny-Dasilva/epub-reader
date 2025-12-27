import { useMemo } from 'react';
import { useLibraryStore } from '@/store/libraryStore';
import { useReadingProgressStore } from '@/store/readingProgressStore';
import { useNavigationStore } from '@/store/navigationStore';
import { getTotalSentenceCount } from '@/lib/epub';

export interface BookWithProgress {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  progress: number; // 0-100
  lastReadAt: number;
  currentChapterIndex: number;
  currentSentenceIndex: number;
  chapterTitle: string;
}

/**
 * Hook to get the most recently read book with progress information.
 * Returns null if no books have been read yet.
 */
export function useLastReadBook(): BookWithProgress | null {
  const books = useLibraryStore(state => state.books);
  const getProgress = useReadingProgressStore(state => state.getProgress);
  const currentBook = useNavigationStore(state => state.currentBook);

  const lastReadBook = useMemo(() => {
    // Filter out books that have never been read (lastReadAt = 0 or undefined)
    const readBooks = books.filter(book => book.lastReadAt && book.lastReadAt > 0);

    if (readBooks.length === 0) {
      return null;
    }

    // Sort by lastReadAt in descending order to get most recent
    const sorted = [...readBooks].sort((a, b) => b.lastReadAt - a.lastReadAt);
    const mostRecent = sorted[0];

    // Get reading progress for this book
    const savedProgress = getProgress(mostRecent.id);

    if (!savedProgress) {
      // Book has been opened but no progress saved yet
      return {
        id: mostRecent.id,
        title: mostRecent.title,
        author: mostRecent.author,
        cover: mostRecent.cover,
        progress: mostRecent.progress || 0,
        lastReadAt: mostRecent.lastReadAt,
        currentChapterIndex: 0,
        currentSentenceIndex: 0,
        chapterTitle: 'Beginning'
      };
    }

    // Calculate progress percentage if we have the book loaded
    let progressPercentage = mostRecent.progress || 0;
    let chapterTitle = `Chapter ${savedProgress.chapterIndex + 1}`;

    // If this is the currently loaded book, we can get more accurate info
    if (currentBook && currentBook.id === mostRecent.id) {
      const totalSentences = getTotalSentenceCount(currentBook);

      // Calculate how many sentences have been read up to current position
      let sentencesRead = 0;
      for (let i = 0; i < savedProgress.chapterIndex; i++) {
        sentencesRead += currentBook.chapters[i].sentences.length;
      }
      sentencesRead += savedProgress.sentenceIndex;

      progressPercentage = totalSentences > 0
        ? Math.round((sentencesRead / totalSentences) * 100)
        : 0;

      // Get actual chapter title
      if (currentBook.chapters[savedProgress.chapterIndex]) {
        chapterTitle = currentBook.chapters[savedProgress.chapterIndex].title;
      }
    }

    return {
      id: mostRecent.id,
      title: mostRecent.title,
      author: mostRecent.author,
      cover: mostRecent.cover,
      progress: progressPercentage,
      lastReadAt: mostRecent.lastReadAt,
      currentChapterIndex: savedProgress.chapterIndex,
      currentSentenceIndex: savedProgress.sentenceIndex,
      chapterTitle
    };
  }, [books, getProgress, currentBook]);

  return lastReadBook;
}
