'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ParsedBook, getReadingProgress } from '@/lib/epub';
import { calculatePagination, PaginationData, getPageForSentence } from '@/lib/epub/pagination';
import { useNavigationStore } from '@/store/navigationStore';
import { usePlaybackStore } from '@/store/playbackStore';
import { useUIStore } from '@/store/uiStore';
import { useTTSStore } from '@/store/ttsStore';
import { useSentenceStateStore, subscribeToHighlight, setHighlight, Highlight, getAudioPosition } from '@/store/sentenceStateStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useReadingProgressStore } from '@/store/readingProgressStore';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import { useVisibilityPause } from '@/hooks/useVisibilityPause';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useMediaSession } from '@/hooks/useMediaSession';
import { useBookSearch } from '@/hooks/useBookSearch';
import { VirtualizedSentenceList } from '@/components/VirtualizedSentenceList';
import { Timeline } from '@/components/Timeline';
import { PlaybackControls } from '@/components/PlaybackControls';
import { SettingsSheet } from '@/components/SettingsSheet';
import { SearchPanel } from '@/components/SearchPanel';
import { PageIndicator } from '@/components/PageIndicator';

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

const SearchIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
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
  const [pagination, setPagination] = useState<PaginationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSearch, setShowSearch] = useState(false);

  // Navigation store
  const currentBook = useNavigationStore(state => state.currentBook);
  const setCurrentBook = useNavigationStore(state => state.setCurrentBook);
  const setChapter = useNavigationStore(state => state.setChapter);
  const setSentenceIndex = useNavigationStore(state => state.setSentenceIndex);
  const currentChapterIndex = useNavigationStore(state => state.currentChapterIndex);
  const currentSentenceIndex = useNavigationStore(state => state.currentSentenceIndex);
  const nextSentence = useNavigationStore(state => state.nextSentence);
  const prevSentence = useNavigationStore(state => state.prevSentence);

  // Reading progress store (persisted)
  const getProgress = useReadingProgressStore(state => state.getProgress);
  const saveProgress = useReadingProgressStore(state => state.saveProgress);

  // Playback store
  const isPlaying = usePlaybackStore(state => state.isPlaying);
  const setIsPlaying = usePlaybackStore(state => state.setIsPlaying);
  const volume = usePlaybackStore(state => state.volume);
  const setVolume = usePlaybackStore(state => state.setVolume);
  const speechRate = usePlaybackStore(state => state.speechRate);
  const setSpeechRate = usePlaybackStore(state => state.setSpeechRate);
  const audioPlaybackRate = usePlaybackStore(state => state.audioPlaybackRate);
  const setAudioPlaybackRate = usePlaybackStore(state => state.setAudioPlaybackRate);
  const enableASR = usePlaybackStore(state => state.enableASR);

  // UI store
  const theme = useUIStore(state => state.theme);
  const fontSize = useUIStore(state => state.fontSize);
  const showSettings = useUIStore(state => state.showSettings);
  const setShowSettings = useUIStore(state => state.setShowSettings);

  // TTS store
  const ttsReady = useTTSStore(state => state.ttsReady);
  const ttsLoading = useTTSStore(state => state.ttsLoading);
  const currentVoice = useTTSStore(state => state.currentVoice);
  const setCurrentVoice = useTTSStore(state => state.setCurrentVoice);

  // Sentence state store - only subscribe to ASR completion state (not sentenceStates or highlight)
  // Do NOT subscribe to sentenceStates map here - let child components subscribe selectively
  const asrCompletedIds = useSentenceStateStore(state => state.asrCompletedIds);

  // Use non-reactive highlight state with RAF batching to avoid 60 re-renders/second
  const [highlight, setHighlightState] = useState<Highlight>({ sentenceId: '', wordIndex: null, timestampSource: null });

  useEffect(() => {
    let rafId: number | null = null;
    let latestHighlight: Highlight | null = null;

    // Subscribe to highlight changes and batch updates with RAF
    const unsubscribe = subscribeToHighlight((newHighlight) => {
      latestHighlight = newHighlight;

      // Cancel any pending RAF
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      // Schedule update for next frame (batches rapid updates)
      rafId = requestAnimationFrame(() => {
        if (latestHighlight) {
          setHighlightState(latestHighlight);
        }
        rafId = null;
      });
    });

    return () => {
      unsubscribe();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  const { updateLastRead } = useLibraryStore();

  // Book search
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    results: searchResults,
    totalMatches: searchTotalMatches,
    isSearching,
    clearSearch
  } = useBookSearch({ book, pagination });

  // Initialize audio playback system
  const {
    initProgress,
    initMessage,
    isServiceReady,
    handlePlayPause: audioPlayPause,
    handleChapterChange,
    skipToSentence
  } = useAudioPlayback();

  // Auto-pause when tab is hidden
  useVisibilityPause();

  // Auto-scroll to current sentence during playback
  useAutoScroll({
    currentSentenceIndex: isPlaying ? currentSentenceIndex : null,
    isPlaying,
    containerRef: mainRef
  });

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
        // Calculate pagination for page numbers
        setPagination(calculatePagination(parsed));

        // Restore saved reading position
        const savedProgress = getProgress(bookId);
        if (savedProgress) {
          // Validate saved position is within bounds
          if (savedProgress.chapterIndex < parsed.chapters.length) {
            setChapter(savedProgress.chapterIndex);
            const chapter = parsed.chapters[savedProgress.chapterIndex];
            if (savedProgress.sentenceIndex < chapter.sentences.length) {
              setSentenceIndex(savedProgress.sentenceIndex);
            }
          }
        }

        updateLastRead(bookId);
        setLoading(false);
        return;
      }

      // If not in sessionStorage, redirect to library
      router.push('/');
    };

    loadBook();
  }, [bookId, router, setCurrentBook, setChapter, setSentenceIndex, getProgress, updateLastRead]);

  // Save reading progress when position changes
  useEffect(() => {
    if (book && currentChapterIndex >= 0 && currentSentenceIndex >= 0) {
      saveProgress(bookId, currentChapterIndex, currentSentenceIndex);
    }
  }, [bookId, book, currentChapterIndex, currentSentenceIndex, saveProgress]);

  // Scroll to and highlight restored position on initial load
  const hasScrolledToPosition = useRef(false);
  useEffect(() => {
    if (!loading && book && !hasScrolledToPosition.current && currentSentenceIndex > 0) {
      const chapter = book.chapters[currentChapterIndex];
      if (chapter) {
        const sentence = chapter.sentences[currentSentenceIndex];
        if (sentence) {
          // Highlight the restored sentence
          setHighlight(sentence.id, null);
        }
      }
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        const element = document.getElementById(`sentence-${currentSentenceIndex}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        hasScrolledToPosition.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [loading, book, currentChapterIndex, currentSentenceIndex, setHighlight]);

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

  // Real-time audio position tracking (updates during playback)
  const [audioOffset, setAudioOffset] = useState(0);

  useEffect(() => {
    if (!isPlaying) {
      setAudioOffset(0);
      return;
    }

    let rafId: number;
    let lastUpdate = 0;

    const updatePosition = () => {
      const now = Date.now();
      // Throttle to ~10fps for UI updates (every 100ms)
      if (now - lastUpdate >= 100) {
        const pos = getAudioPosition();
        if (pos.lastUpdate > 0) {
          setAudioOffset(pos.withinSentenceTime);
          lastUpdate = now;
        }
      }
      rafId = requestAnimationFrame(updatePosition);
    };

    rafId = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying]);

  // Display time: sentence-based time + real-time audio offset when playing
  const displayTime = isPlaying ? currentTime + audioOffset : currentTime;

  // Calculate book progress percentage
  const bookProgress = useMemo(() => {
    if (!book) return 0;
    return getReadingProgress(book, currentChapterIndex, currentSentenceIndex);
  }, [book, currentChapterIndex, currentSentenceIndex]);

  // Get current page from pagination data
  const currentPageInfo = useMemo(() => {
    if (!pagination) return { pageNumber: 0, totalPages: 0 };
    return getPageForSentence(pagination, currentChapterIndex, currentSentenceIndex);
  }, [pagination, currentChapterIndex, currentSentenceIndex]);

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

  // Handle previous chapter
  const handlePrevChapter = useCallback(() => {
    if (book && currentChapterIndex > 0) {
      handleChapterChange(currentChapterIndex - 1);
    }
  }, [book, currentChapterIndex, handleChapterChange]);

  // Handle skip back/forward by ~15 seconds (estimate based on sentences)
  // Assuming ~3-4 seconds per sentence on average at 1x speed
  const SENTENCES_PER_15_SECONDS = 4;

  const handleSkipBack = useCallback(() => {
    if (!currentChapter) return;
    const newIndex = Math.max(0, currentSentenceIndex - SENTENCES_PER_15_SECONDS);
    skipToSentence(newIndex);
  }, [currentChapter, currentSentenceIndex, skipToSentence]);

  const handleSkipForward = useCallback(() => {
    if (!currentChapter) return;
    const maxIndex = currentChapter.sentences.length - 1;
    const newIndex = Math.min(maxIndex, currentSentenceIndex + SENTENCES_PER_15_SECONDS);
    skipToSentence(newIndex);
  }, [currentChapter, currentSentenceIndex, skipToSentence]);

  // Handle search result click - navigate to chapter and sentence
  const handleSearchResultClick = useCallback((chapterIndex: number, sentenceIndex: number) => {
    // If different chapter, change to it first
    if (chapterIndex !== currentChapterIndex) {
      handleChapterChange(chapterIndex);
      // Need to wait for chapter change, then set sentence
      // For now, just go to the chapter - sentence navigation happens via skipToSentence
      setTimeout(() => {
        skipToSentence(sentenceIndex);
      }, 100);
    } else {
      skipToSentence(sentenceIndex);
    }
    setShowSearch(false);
    clearSearch();
  }, [currentChapterIndex, handleChapterChange, skipToSentence, clearSearch]);

  // Chapter navigation availability
  const canGoPrevChapter = book ? currentChapterIndex > 0 : false;
  const canGoNextChapter = book ? currentChapterIndex < book.chapters.length - 1 : false;

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onSkipBack: handleSkipBack,
    onSkipForward: handleSkipForward
  });

  // Media Session for lock screen controls (when background playback enabled)
  useMediaSession({
    onPlay: handlePlayPause,
    onPause: handlePlayPause,
    onNextSentence: handleNextSentence,
    onPrevSentence: handlePrevSentence,
    onSeekForward: handleSkipForward,
    onSeekBackward: handleSkipBack
  });

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

        {/* Search button */}
        <button
          onClick={() => setShowSearch(true)}
          className="playback-btn"
          title="Search in book"
        >
          <SearchIcon />
        </button>
      </header>

      {/* Search Panel */}
      <SearchPanel
        isOpen={showSearch}
        onClose={() => {
          setShowSearch(false);
          clearSearch();
        }}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        results={searchResults}
        totalMatches={searchTotalMatches}
        isSearching={isSearching}
        onResultClick={handleSearchResultClick}
      />

      {/* Page Indicator - Left Margin Marginalia */}
      {currentPageInfo.pageNumber > 0 && (
        <PageIndicator
          currentPage={currentPageInfo.pageNumber}
          totalPages={currentPageInfo.totalPages}
        />
      )}

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
                currentIndex={currentSentenceIndex}
                highlightedSentenceId={highlight.sentenceId}
                highlightedWordIndex={highlight.wordIndex}
                highlightTimestampSource={highlight.timestampSource}
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
            sentenceIds={sentenceIds}
            asrCompletedIds={asrCompletedIds}
            onSeek={handleTimelineSeek}
            estimatedDuration={estimatedDuration}
            currentTime={displayTime}
            enableASR={enableASR}
            bookProgress={bookProgress}
          />

          {/* Playback Controls */}
          <PlaybackControls
            isPlaying={isPlaying}
            playbackSpeed={audioPlaybackRate}
            ttsLoading={ttsLoading}
            ttsReady={ttsReady}
            onPlayPause={handlePlayPause}
            onSkipBack={handleSkipBack}
            onSkipForward={handleSkipForward}
            onPrevChapter={handlePrevChapter}
            onNextChapter={handleNextChapter}
            onSpeedChange={setAudioPlaybackRate}
            onSettingsOpen={() => setShowSettings(true)}
            canGoPrevChapter={canGoPrevChapter}
            canGoNextChapter={canGoNextChapter}
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
        speechRate={speechRate}
        onSpeechRateChange={setSpeechRate}
        audioPlaybackRate={audioPlaybackRate}
        onAudioPlaybackRateChange={setAudioPlaybackRate}
        chapters={book.chapters}
        currentChapterIndex={currentChapterIndex}
        onChapterSelect={handleChapterSelect}
      />
    </div>
  );
}
