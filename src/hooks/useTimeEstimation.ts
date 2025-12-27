/**
 * useTimeEstimation Hook
 *
 * Calculates time estimates for chapter and book completion based on
 * actual reading pace tracked during playback.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { ParsedBook } from '@/lib/epub/types';
import { ReadingPaceTracker } from '@/lib/stats/ReadingPaceTracker';
import { getAudioPosition } from '@/store/sentenceStateStore';

export interface TimeEstimate {
  chapterRemaining: { ms: number; formatted: string };
  bookRemaining: { ms: number; formatted: string };
  estimatedFinishTime: Date | null;
  readingPace: { sentencesPerMinute: number };
}

/**
 * Format duration in milliseconds to human-readable string
 * e.g., "2h 30m", "45m", "30s"
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.round(ms / 60000);

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Hook for calculating time estimates based on reading pace
 */
export function useTimeEstimation(
  book: ParsedBook | null,
  currentChapterIndex: number,
  currentSentenceIndex: number,
  isPlaying: boolean
): TimeEstimate {
  const paceTrackerRef = useRef<ReadingPaceTracker>(new ReadingPaceTracker());
  const lastSentenceRef = useRef<string | null>(null);
  const sentenceStartTimeRef = useRef<number | null>(null);
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [estimate, setEstimate] = useState<TimeEstimate>({
    chapterRemaining: { ms: 0, formatted: '0m' },
    bookRemaining: { ms: 0, formatted: '0m' },
    estimatedFinishTime: null,
    readingPace: { sentencesPerMinute: 12 } // Default: ~5s per sentence
  });

  // Start tracking session when playback starts
  useEffect(() => {
    if (isPlaying && !book) return;

    if (isPlaying) {
      paceTrackerRef.current.startSession();
    }
  }, [isPlaying, book]);

  // Track sentence completions
  useEffect(() => {
    if (!isPlaying || !book) return;

    const currentChapter = book.chapters[currentChapterIndex];
    if (!currentChapter) return;

    const currentSentence = currentChapter.sentences[currentSentenceIndex];
    if (!currentSentence) return;

    const currentSentenceId = currentSentence.id;

    // Check if we've moved to a new sentence
    if (lastSentenceRef.current && lastSentenceRef.current !== currentSentenceId) {
      // Record the time it took to complete the previous sentence
      if (sentenceStartTimeRef.current !== null) {
        const duration = Date.now() - sentenceStartTimeRef.current;
        paceTrackerRef.current.recordSentenceComplete(duration);
      }
    }

    // Update refs for current sentence
    lastSentenceRef.current = currentSentenceId;
    sentenceStartTimeRef.current = Date.now();
  }, [isPlaying, book, currentChapterIndex, currentSentenceIndex]);

  // Calculate estimates
  const calculateEstimates = useCallback(() => {
    if (!book) {
      return {
        chapterRemaining: { ms: 0, formatted: '0m' },
        bookRemaining: { ms: 0, formatted: '0m' },
        estimatedFinishTime: null,
        readingPace: { sentencesPerMinute: 12 }
      };
    }

    const currentChapter = book.chapters[currentChapterIndex];
    if (!currentChapter) {
      return {
        chapterRemaining: { ms: 0, formatted: '0m' },
        bookRemaining: { ms: 0, formatted: '0m' },
        estimatedFinishTime: null,
        readingPace: { sentencesPerMinute: 12 }
      };
    }

    const paceTracker = paceTrackerRef.current;

    // Calculate sentences remaining in current chapter
    const sentencesRemainingInChapter = Math.max(
      0,
      currentChapter.sentences.length - currentSentenceIndex - 1
    );

    // Calculate chapter remaining time
    const chapterRemainingMs = paceTracker.estimateTimeForSentences(
      sentencesRemainingInChapter
    );

    // Calculate sentences remaining in subsequent chapters
    let sentencesRemainingInBook = sentencesRemainingInChapter;

    for (let i = currentChapterIndex + 1; i < book.chapters.length; i++) {
      sentencesRemainingInBook += book.chapters[i].sentences.length;
    }

    // Calculate book remaining time
    const bookRemainingMs = paceTracker.estimateTimeForSentences(
      sentencesRemainingInBook
    );

    // Calculate estimated finish time
    const estimatedFinishTime = bookRemainingMs > 0
      ? new Date(Date.now() + bookRemainingMs)
      : null;

    // Get reading pace
    const sentencesPerMinute = paceTracker.getSentencesPerMinute();

    return {
      chapterRemaining: {
        ms: chapterRemainingMs,
        formatted: formatDuration(chapterRemainingMs)
      },
      bookRemaining: {
        ms: bookRemainingMs,
        formatted: formatDuration(bookRemainingMs)
      },
      estimatedFinishTime,
      readingPace: { sentencesPerMinute }
    };
  }, [book, currentChapterIndex, currentSentenceIndex]);

  // Update estimates periodically during playback
  useEffect(() => {
    // Calculate immediately
    setEstimate(calculateEstimates());

    if (isPlaying) {
      // Update every 5 seconds during playback
      updateIntervalRef.current = setInterval(() => {
        setEstimate(calculateEstimates());
      }, 5000);
    }

    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current);
        updateIntervalRef.current = null;
      }
    };
  }, [isPlaying, calculateEstimates]);

  // Recalculate when position changes
  useEffect(() => {
    setEstimate(calculateEstimates());
  }, [currentChapterIndex, currentSentenceIndex, calculateEstimates]);

  return estimate;
}
