'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ParsedBook } from '@/lib/epub';
import { useReaderStore } from '@/store/readerStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import { VirtualizedSentenceList } from '@/components/VirtualizedSentenceList';
import { Timeline } from '@/components/Timeline';
import { PlaybackControls } from '@/components/PlaybackControls';
import { SettingsSheet } from '@/components/SettingsSheet';

// Icons
const BackIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const ChevronRightIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// Estimate reading time based on sentence count
function estimateReadingTime(sentenceCount: number, wordsPerSentence = 15, wpm = 150): number {
  const totalWords = sentenceCount * wordsPerSentence;
  return (totalWords / wpm) * 60; // seconds
}

export default function ReaderPage() {
  const params = useParams();
  const router = useRouter();
  const bookId = params.bookId as string;
  const contentRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const [book, setBook] = useState<ParsedBook | null>(null);
  const [loading, setLoading] = useState(true);

  const {
    currentBook,
    setCurrentBook,
    currentChapterIndex,
    currentSentenceIndex,
    setSentence,
    nextSentence,
    prevSentence,
    theme,
    fontSize,
    isPlaying,
    setIsPlaying,
    highlightedSentenceId,
    highlightedWordIndex,
    setHighlight,
    sentenceStates,
    ttsReady,
    ttsLoading,
    currentVoice,
    setCurrentVoice,
    volume,
    setVolume,
    playbackSpeed,
    setPlaybackSpeed,
    showSettings,
    setShowSettings
  } = useReaderStore();

  const { updateLastRead } = useLibraryStore();

  // Initialize audio playback system
  const {
    initProgress,
    initMessage,
    isServiceReady,
    handlePlayPause: audioPlayPause,
    handleChapterChange,
    skipToSentence
  } = useAudioPlayback();

  // Load book from sessionStorage or library
  useEffect(() => {
    const loadBook = async () => {
      setLoading(true);

      // Try sessionStorage first
      const storedBook = sessionStorage.getItem(`book-${bookId}`);
      if (storedBook) {
        const parsed = JSON.parse(storedBook) as ParsedBook;
        setBook(parsed);
        setCurrentBook(parsed);
        updateLastRead(bookId);
        setLoading(false);
        return;
      }

      // If not in sessionStorage, redirect to library
      router.push('/');
    };

    loadBook();
  }, [bookId, router, setCurrentBook, updateLastRead]);

  // Get current chapter
  const currentChapter = book?.chapters[currentChapterIndex] ?? null;

  // Get sentence IDs for timeline
  const sentenceIds = useMemo(() => {
    return currentChapter?.sentences.map(s => s.id) ?? [];
  }, [currentChapter]);

  // Estimate time progress
  const estimatedDuration = useMemo(() => {
    if (!currentChapter) return 0;
    return estimateReadingTime(currentChapter.sentences.length);
  }, [currentChapter]);

  const currentTime = useMemo(() => {
    if (!currentChapter) return 0;
    const sentencesRead = currentSentenceIndex;
    return estimateReadingTime(sentencesRead);
  }, [currentChapter, currentSentenceIndex]);

  // Scroll to current sentence when it changes
  useEffect(() => {
    if (!currentChapter || !contentRef.current) return;

    const sentenceEl = document.getElementById(
      `sentence-${currentChapterIndex}-${currentSentenceIndex}`
    );

    if (sentenceEl) {
      sentenceEl.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
    }
  }, [currentChapterIndex, currentSentenceIndex, currentChapter]);

  // Scroll to top when chapter changes
  useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [currentChapterIndex]);

  // Handle sentence click - starts playback from clicked sentence
  // skipToSentence handles ALL state updates and playback to avoid race conditions
  const handleSentenceClick = useCallback((sentenceIndex: number) => {
    skipToSentence(sentenceIndex);
  }, [skipToSentence]);

  // Handle play/pause
  const handlePlayPause = useCallback(() => {
    if (!isPlaying && currentChapter) {
      const sentence = currentChapter.sentences[currentSentenceIndex];
      if (sentence) {
        setHighlight(sentence.id, null);
      }
    }
    audioPlayPause();
  }, [isPlaying, currentChapter, currentSentenceIndex, setHighlight, audioPlayPause]);

  // Handle previous/next sentence
  const handlePrevSentence = useCallback(() => {
    prevSentence();
  }, [prevSentence]);

  const handleNextSentence = useCallback(() => {
    nextSentence();
  }, [nextSentence]);

  // Handle chapter selection from settings
  const handleChapterSelect = useCallback((index: number) => {
    handleChapterChange(index);
  }, [handleChapterChange]);

  // Handle timeline seek - same as sentence click
  const handleTimelineSeek = useCallback((index: number) => {
    skipToSentence(index);
  }, [skipToSentence]);

  // Handle next chapter at end
  const handleNextChapter = useCallback(() => {
    if (book && currentChapterIndex < book.chapters.length - 1) {
      handleChapterChange(currentChapterIndex + 1);
    }
  }, [book, currentChapterIndex, handleChapterChange]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-theme="dark" style={{ background: 'var(--bg)' }}>
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-[var(--text-muted)] border-t-[var(--accent,var(--color-accent-purple))] rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[var(--text-muted)] text-sm">Loading book...</p>
        </div>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-theme="dark" style={{ background: 'var(--bg)' }}>
        <div className="text-center">
          <p className="text-[var(--text)] mb-4">Book not found</p>
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 bg-[var(--text)] text-[var(--bg)] rounded-lg text-sm font-medium"
          >
            Return to Library
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      data-theme={theme}
      style={{
        background: 'var(--bg)',
        color: 'var(--text)'
      }}
    >
      {/* Minimal Header */}
      <header className="reader-header sticky top-0 z-30 relative">
        <button
          onClick={() => router.push('/')}
          className="playback-btn"
          title="Back to Library"
        >
          <BackIcon />
        </button>

        <span className="reader-header-title">
          {currentChapter?.title || book.title}
        </span>

        {/* Empty spacer for balance */}
        <div className="w-11" />
      </header>

      {/* Main Content Area */}
      <main ref={mainRef} className="flex-1 overflow-y-auto">
        <div
          ref={contentRef}
          className="max-w-2xl mx-auto px-4 py-8 pb-48"
        >
          {currentChapter && (
            <article className="prose-reading animate-fade-in" style={{ fontSize: `${fontSize}px` }}>
              {/* Chapter Title */}
              <header className="mb-8 text-center">
                <p className="text-xs uppercase tracking-[0.15em] text-[var(--text-muted)] mb-2">
                  Chapter {currentChapterIndex + 1} of {book.chapters.length}
                </p>
                <h2 className="text-xl font-serif font-medium">
                  {currentChapter.title}
                </h2>
              </header>

              {/* Sentences */}
              <VirtualizedSentenceList
                sentences={currentChapter.sentences}
                sentenceStates={sentenceStates}
                currentIndex={currentSentenceIndex}
                highlightedSentenceId={highlightedSentenceId}
                highlightedWordIndex={highlightedWordIndex}
                onSentenceClick={handleSentenceClick}
                isPlaying={isPlaying}
              />

              {/* End of Chapter */}
              <div className="mt-12 pt-6 border-t border-[var(--border)] text-center">
                <p className="text-sm text-[var(--text-muted)] mb-4">
                  End of {currentChapter.title}
                </p>
                {currentChapterIndex < book.chapters.length - 1 ? (
                  <button
                    onClick={handleNextChapter}
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-[var(--text)] text-[var(--bg)] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                  >
                    Continue to next chapter
                    <ChevronRightIcon />
                  </button>
                ) : (
                  <p className="text-[var(--text-muted)]">You&apos;ve reached the end of the book</p>
                )}
              </div>
            </article>
          )}
        </div>
      </main>

      {/* Fixed Bottom Playback Bar */}
      <footer className="playback-bar fixed bottom-0 left-0 right-0 z-20">
        <div className="max-w-2xl mx-auto">
          {/* Timeline */}
          <Timeline
            totalSentences={currentChapter?.sentences.length ?? 0}
            currentIndex={currentSentenceIndex}
            sentenceStates={sentenceStates}
            sentenceIds={sentenceIds}
            onSeek={handleTimelineSeek}
            estimatedDuration={estimatedDuration}
            currentTime={currentTime}
          />

          {/* Playback Controls */}
          <PlaybackControls
            isPlaying={isPlaying}
            playbackSpeed={playbackSpeed}
            ttsLoading={ttsLoading}
            ttsReady={ttsReady}
            onPlayPause={handlePlayPause}
            onPrevSentence={handlePrevSentence}
            onNextSentence={handleNextSentence}
            onSpeedChange={setPlaybackSpeed}
            onSettingsOpen={() => setShowSettings(true)}
          />

          {/* TTS Loading Status */}
          {ttsLoading && (
            <div className="px-4 pb-3">
              <div className="flex items-center justify-center gap-2 mb-1">
                <div className="w-24 h-1 bg-[var(--border)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent,var(--color-accent-purple))] transition-all duration-300"
                    style={{ width: `${initProgress}%` }}
                  />
                </div>
                <span className="text-xs text-[var(--text-muted)]">{Math.round(initProgress)}%</span>
              </div>
              <p className="text-center text-xs text-[var(--text-muted)]">
                {initMessage}
              </p>
            </div>
          )}
        </div>
      </footer>

      {/* Settings Bottom Sheet */}
      <SettingsSheet
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        currentVoice={currentVoice}
        onVoiceChange={setCurrentVoice}
        volume={volume}
        onVolumeChange={setVolume}
        chapters={book.chapters}
        currentChapterIndex={currentChapterIndex}
        onChapterSelect={handleChapterSelect}
      />
    </div>
  );
}
