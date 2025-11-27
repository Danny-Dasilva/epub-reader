'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ParsedBook, Chapter, Sentence } from '@/lib/epub';
import { useReaderStore } from '@/store/readerStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import { VirtualizedSentenceList } from '@/components/VirtualizedSentenceList';

// Icons
const PlayIcon = () => (
  <svg className="w-6 h-6 ml-0.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
  </svg>
);

const ChevronLeftIcon = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={`icon ${className}`} viewBox="0 0 24 24">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const ChevronRightIcon = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={`icon ${className}`} viewBox="0 0 24 24">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const ChevronUpIcon = () => (
  <svg className="icon w-4 h-4" viewBox="0 0 24 24">
    <polyline points="18 15 12 9 6 15" />
  </svg>
);

const ChevronDownIcon = () => (
  <svg className="icon w-4 h-4" viewBox="0 0 24 24">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const HomeIcon = () => (
  <svg className="icon w-5 h-5" viewBox="0 0 24 24">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

const ListIcon = () => (
  <svg className="icon w-5 h-5" viewBox="0 0 24 24">
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const SkipBackIcon = () => (
  <svg className="icon w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="19 20 9 12 19 4 19 20" />
    <line x1="5" y1="19" x2="5" y2="5" strokeWidth="2" stroke="currentColor" />
  </svg>
);

const SkipForwardIcon = () => (
  <svg className="icon w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 4 15 12 5 20 5 4" />
    <line x1="19" y1="5" x2="19" y2="19" strokeWidth="2" stroke="currentColor" />
  </svg>
);

const VolumeIcon = ({ muted }: { muted?: boolean }) => (
  <svg className="icon w-4 h-4" viewBox="0 0 24 24">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    {!muted && (
      <>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </>
    )}
    {muted && (
      <line x1="23" y1="9" x2="17" y2="15" />
    )}
  </svg>
);

export default function ReaderPage() {
  const params = useParams();
  const router = useRouter();
  const bookId = params.bookId as string;
  const contentRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const [book, setBook] = useState<ParsedBook | null>(null);
  const [loading, setLoading] = useState(true);
  const [showChapterPicker, setShowChapterPicker] = useState(false);
  const [showToc, setShowToc] = useState(false);

  const {
    currentBook,
    setCurrentBook,
    currentChapterIndex,
    currentSentenceIndex,
    setChapter,
    setSentence,
    nextSentence,
    prevSentence,
    nextChapter,
    prevChapter,
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
    setPlaybackSpeed
  } = useReaderStore();

  const { updateLastRead, updateProgress } = useLibraryStore();

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
  const handleSentenceClick = useCallback((sentenceIndex: number) => {
    setSentence(sentenceIndex);
    const sentenceId = currentChapter?.sentences[sentenceIndex]?.id ?? null;
    setHighlight(sentenceId, null);

    // Always start playback on click
    if (!isPlaying) {
      setIsPlaying(true);
    } else {
      skipToSentence(sentenceIndex);
    }
  }, [setSentence, setHighlight, currentChapter, isPlaying, setIsPlaying, skipToSentence]);

  // Handle play/pause - OPTIMISTIC: uses the audioPlayPause which updates state immediately
  const handlePlayPause = useCallback(() => {
    // Set highlight before toggling play state
    if (!isPlaying && currentChapter) {
      const sentence = currentChapter.sentences[currentSentenceIndex];
      if (sentence) {
        setHighlight(sentence.id, null);
      }
    }
    // Use the optimistic play/pause from useAudioPlayback
    audioPlayPause();
  }, [isPlaying, currentChapter, currentSentenceIndex, setHighlight, audioPlayPause]);

  // Handle previous/next sentence
  const handlePrevSentence = useCallback(() => {
    prevSentence();
  }, [prevSentence]);

  const handleNextSentence = useCallback(() => {
    nextSentence();
  }, [nextSentence]);

  // Handle previous/next chapter - cancels operations and changes chapter
  const handlePrevChapter = useCallback(() => {
    if (currentChapterIndex > 0) {
      handleChapterChange(currentChapterIndex - 1);
    }
    setShowChapterPicker(false);
  }, [currentChapterIndex, handleChapterChange]);

  const handleNextChapter = useCallback(() => {
    if (book && currentChapterIndex < book.chapters.length - 1) {
      handleChapterChange(currentChapterIndex + 1);
    }
    setShowChapterPicker(false);
  }, [book, currentChapterIndex, handleChapterChange]);

  // Handle chapter selection - cancels operations and changes chapter
  const handleChapterSelect = useCallback((index: number) => {
    handleChapterChange(index);
    setShowChapterPicker(false);
    setShowToc(false);
  }, [handleChapterChange]);

  // Calculate progress
  const chapterProgress = book
    ? ((currentChapterIndex + 1) / book.chapters.length) * 100
    : 0;

  const sentenceProgress = currentChapter
    ? ((currentSentenceIndex + 1) / currentChapter.sentences.length) * 100
    : 0;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-paper-warm)]" data-theme="sepia">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-[var(--color-sepia)] border-t-[var(--color-gold)] rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[var(--color-ink-muted)]">Loading book...</p>
        </div>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-paper-warm)]" data-theme="sepia">
        <div className="text-center">
          <p className="text-[var(--color-ink)]">Book not found</p>
          <button
            onClick={() => router.push('/')}
            className="btn btn-primary mt-4"
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
      {/* Compact Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg-surface)]/95 backdrop-blur-sm">
        <div className="flex items-center justify-between px-4 py-2">
          {/* Left: Home & TOC */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push('/')}
              className="p-2 rounded-lg hover:bg-[var(--highlight-sentence)] transition-colors"
              title="Library"
            >
              <HomeIcon />
            </button>

            <button
              onClick={() => setShowToc(!showToc)}
              className={`p-2 rounded-lg transition-colors ${showToc ? 'bg-[var(--highlight-sentence)]' : 'hover:bg-[var(--highlight-sentence)]'}`}
              title="Table of Contents"
            >
              <ListIcon />
            </button>
          </div>

          {/* Center: Chapter Navigation */}
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrevChapter}
              disabled={currentChapterIndex === 0}
              className="p-2 rounded-lg hover:bg-[var(--highlight-sentence)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous chapter"
            >
              <ChevronLeftIcon className="w-4 h-4" />
            </button>

            <button
              onClick={() => setShowChapterPicker(!showChapterPicker)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-[var(--highlight-sentence)] transition-colors min-w-[180px] justify-center"
            >
              <span className="text-sm font-medium truncate max-w-[140px]">
                {currentChapter?.title || `Chapter ${currentChapterIndex + 1}`}
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                {currentChapterIndex + 1}/{book.chapters.length}
              </span>
              {showChapterPicker ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </button>

            <button
              onClick={handleNextChapter}
              disabled={currentChapterIndex === book.chapters.length - 1}
              className="p-2 rounded-lg hover:bg-[var(--highlight-sentence)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next chapter"
            >
              <ChevronRightIcon className="w-4 h-4" />
            </button>
          </div>

          {/* Right: Book Title */}
          <div className="flex items-center">
            <span className="text-sm text-[var(--text-muted)] truncate max-w-[150px]">
              {book.title}
            </span>
          </div>
        </div>

        {/* Progress bars */}
        <div className="flex h-1">
          <div className="flex-1 bg-[var(--border)]">
            <div
              className="h-full bg-gradient-to-r from-[var(--color-sepia-dark)] to-[var(--color-gold)] transition-all duration-300"
              style={{ width: `${chapterProgress}%` }}
            />
          </div>
        </div>

        {/* Chapter Picker Dropdown */}
        {showChapterPicker && (
          <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 w-80 max-h-96 overflow-y-auto bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg shadow-xl z-50">
            <div className="p-2">
              <p className="text-xs text-[var(--text-muted)] px-3 py-2 uppercase tracking-wider">
                Chapters
              </p>
              {book.chapters.map((chapter, index) => (
                <button
                  key={chapter.id}
                  onClick={() => handleChapterSelect(index)}
                  className={`w-full text-left px-3 py-2.5 rounded-md transition-colors flex items-center gap-3 ${
                    index === currentChapterIndex
                      ? 'bg-[var(--color-gold)]/20 text-[var(--text)]'
                      : 'hover:bg-[var(--highlight-sentence)] text-[var(--text-muted)]'
                  }`}
                >
                  <span className={`text-xs font-mono w-6 ${index === currentChapterIndex ? 'text-[var(--color-gold)]' : ''}`}>
                    {index + 1}
                  </span>
                  <span className="truncate flex-1 text-sm">{chapter.title}</span>
                  {index === currentChapterIndex && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-gold)]" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* Click outside to close chapter picker */}
      {showChapterPicker && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setShowChapterPicker(false)}
        />
      )}

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* TOC Sidebar */}
        {showToc && (
          <aside className="w-72 border-r border-[var(--border)] bg-[var(--bg-surface)] overflow-y-auto flex-shrink-0">
            <div className="p-4">
              <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] mb-3">
                Table of Contents
              </h2>
              <nav className="space-y-0.5">
                {book.chapters.map((chapter, index) => (
                  <button
                    key={chapter.id}
                    onClick={() => handleChapterSelect(index)}
                    className={`toc-item w-full text-left ${
                      index === currentChapterIndex ? 'active' : ''
                    }`}
                  >
                    <span className="line-clamp-2">{chapter.title}</span>
                  </button>
                ))}
              </nav>
            </div>
          </aside>
        )}

        {/* Reading Content */}
        <main ref={mainRef} className="flex-1 overflow-y-auto">
          <div
            ref={contentRef}
            className="max-w-2xl mx-auto px-6 py-10 pb-40"
          >
            {currentChapter && (
              <article className="prose-reading animate-fade-in" style={{ fontSize: `${fontSize}px` }}>
                {/* Chapter Title */}
                <header className="mb-10 text-center">
                  <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)] mb-2">
                    Chapter {currentChapterIndex + 1}
                  </p>
                  <h2 className="text-2xl font-serif font-semibold">
                    {currentChapter.title}
                  </h2>
                </header>

                {/* Sentences with virtualization and preload indicators */}
                <VirtualizedSentenceList
                  sentences={currentChapter.sentences}
                  sentenceStates={sentenceStates}
                  currentIndex={currentSentenceIndex}
                  highlightedSentenceId={highlightedSentenceId}
                  highlightedWordIndex={highlightedWordIndex}
                  onSentenceClick={handleSentenceClick}
                  isPlaying={isPlaying}
                />

                {/* End of Chapter Indicator */}
                <div className="mt-16 pt-8 border-t border-[var(--border)] text-center">
                  <p className="text-sm text-[var(--text-muted)] mb-4">
                    End of {currentChapter.title}
                  </p>
                  {currentChapterIndex < book.chapters.length - 1 ? (
                    <button
                      onClick={handleNextChapter}
                      className="inline-flex items-center gap-2 px-6 py-3 bg-[var(--color-ink)] text-[var(--color-paper)] rounded-lg hover:opacity-90 transition-opacity"
                    >
                      Continue to next chapter
                      <ChevronRightIcon className="w-4 h-4" />
                    </button>
                  ) : (
                    <p className="text-[var(--text-muted)]">You&apos;ve reached the end of the book</p>
                  )}
                </div>
              </article>
            )}
          </div>
        </main>
      </div>

      {/* Playback Controls - Fixed Bottom Bar */}
      <footer className="playback-bar fixed bottom-0 left-0 right-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3">
          {/* Sentence progress within chapter */}
          <div className="h-0.5 bg-[var(--border)] rounded-full mb-3 overflow-hidden">
            <div
              className="h-full bg-[var(--color-gold)] transition-all duration-150"
              style={{ width: `${sentenceProgress}%` }}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            {/* Left: Sentence Navigation */}
            <div className="flex items-center gap-1">
              <button
                onClick={handlePrevSentence}
                className="p-2 rounded-full hover:bg-[var(--highlight-sentence)] transition-colors"
                title="Previous sentence"
              >
                <ChevronLeftIcon className="w-4 h-4" />
              </button>
              <span className="text-xs text-[var(--text-muted)] min-w-[50px] text-center">
                {currentSentenceIndex + 1}/{currentChapter?.sentences.length || 0}
              </span>
              <button
                onClick={handleNextSentence}
                className="p-2 rounded-full hover:bg-[var(--highlight-sentence)] transition-colors"
                title="Next sentence"
              >
                <ChevronRightIcon className="w-4 h-4" />
              </button>
            </div>

            {/* Center: Play Controls */}
            <div className="flex items-center gap-3">
              <button
                onClick={handlePrevChapter}
                disabled={currentChapterIndex === 0}
                className="p-2 rounded-full hover:bg-[var(--highlight-sentence)] transition-colors disabled:opacity-30"
                title="Previous chapter"
              >
                <SkipBackIcon />
              </button>

              <button
                onClick={handlePlayPause}
                className="play-button w-14 h-14"
                disabled={!ttsReady && !ttsLoading}
              >
                {ttsLoading ? (
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : isPlaying ? (
                  <PauseIcon />
                ) : (
                  <PlayIcon />
                )}
              </button>

              <button
                onClick={handleNextChapter}
                disabled={currentChapterIndex === book.chapters.length - 1}
                className="p-2 rounded-full hover:bg-[var(--highlight-sentence)] transition-colors disabled:opacity-30"
                title="Next chapter"
              >
                <SkipForwardIcon />
              </button>
            </div>

            {/* Right: Volume & Voice */}
            <div className="flex items-center gap-4">
              {/* Volume Control */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setVolume(volume === 0 ? 1 : 0)}
                  className="p-1 rounded hover:bg-[var(--highlight-sentence)] transition-colors"
                  title={volume === 0 ? 'Unmute' : 'Mute'}
                >
                  <VolumeIcon muted={volume === 0} />
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-16 h-1 accent-[var(--color-gold)] cursor-pointer"
                  title={`Volume: ${Math.round(volume * 100)}%`}
                />
              </div>

              {/* Speed Control - Preset Buttons */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--text-muted)] mr-1">Speed</span>
                {[0.75, 1.0, 1.25, 1.5, 2.0].map((speed) => (
                  <button
                    key={speed}
                    onClick={() => setPlaybackSpeed(speed)}
                    className={`
                      px-2 py-1 text-xs rounded transition-all
                      ${playbackSpeed === speed
                        ? 'bg-[var(--color-gold)] text-[var(--color-ink)] font-medium'
                        : 'hover:bg-[var(--highlight-sentence)] text-[var(--text-muted)]'}
                    `}
                    title={`${speed}x speed`}
                  >
                    {speed}x
                  </button>
                ))}
              </div>

              {/* Voice Selector */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--text-muted)] mr-1">Voice</span>
                {(['M1', 'M2', 'F1', 'F2'] as const).map((voice) => (
                  <button
                    key={voice}
                    onClick={() => setCurrentVoice(voice)}
                    className={`
                      w-8 h-8 text-xs rounded-full transition-all
                      ${currentVoice === voice
                        ? 'bg-[var(--color-gold)] text-[var(--color-ink)] font-medium'
                        : 'hover:bg-[var(--highlight-sentence)] text-[var(--text-muted)]'}
                    `}
                    title={`${voice.startsWith('M') ? 'Male' : 'Female'} voice ${voice.charAt(1)}`}
                  >
                    {voice}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* TTS Loading Status */}
          {ttsLoading && (
            <div className="mt-3">
              <div className="flex items-center justify-center gap-2 mb-1">
                <div className="w-32 h-1 bg-[var(--border)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--color-gold)] transition-all duration-300"
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
    </div>
  );
}
