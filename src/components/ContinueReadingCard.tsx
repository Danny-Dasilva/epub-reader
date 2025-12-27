'use client';

import { useRouter } from 'next/navigation';
import { BookWithProgress } from '@/hooks/useLastReadBook';

interface ContinueReadingCardProps {
  book: BookWithProgress;
}

// Helper function to format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  if (days < 30) return `${Math.floor(days / 7)} ${Math.floor(days / 7) === 1 ? 'week' : 'weeks'} ago`;
  return `${Math.floor(days / 30)} ${Math.floor(days / 30) === 1 ? 'month' : 'months'} ago`;
}

// Icons
const BookmarkIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

const PlayIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const InfoIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

export function ContinueReadingCard({ book }: ContinueReadingCardProps) {
  const router = useRouter();

  const handleResume = () => {
    // Navigate with URL params to restore position and autoplay
    const params = new URLSearchParams({
      chapter: book.currentChapterIndex.toString(),
      sentence: book.currentSentenceIndex.toString(),
      autoplay: 'true'
    });
    router.push(`/reader/${book.id}?${params.toString()}`);
  };

  const handleViewDetails = () => {
    // Just navigate to the book without autoplay
    const params = new URLSearchParams({
      chapter: book.currentChapterIndex.toString(),
      sentence: book.currentSentenceIndex.toString()
    });
    router.push(`/reader/${book.id}?${params.toString()}`);
  };

  return (
    <div className="continue-reading-card group">
      <div className="continue-reading-content">
        {/* Book Cover */}
        <div className="continue-reading-cover">
          {book.cover ? (
            <img
              src={book.cover}
              alt={book.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center p-3 bg-gradient-to-br from-[var(--color-paper-dark)] to-[var(--color-sepia)]">
              <BookmarkIcon />
            </div>
          )}
        </div>

        {/* Book Info */}
        <div className="continue-reading-info">
          <div className="flex items-start gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-[var(--color-gold-light)] text-[var(--color-ink)] flex items-center justify-center flex-shrink-0">
              <BookmarkIcon />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs uppercase tracking-wider text-[var(--color-ink-muted)] mb-1">
                Continue Reading
              </p>
              <h3 className="text-lg font-serif font-semibold text-[var(--color-ink)] line-clamp-1 group-hover:text-[var(--color-gold)] transition-colors">
                {book.title}
              </h3>
              <p className="text-sm text-[var(--color-ink-muted)] line-clamp-1">
                {book.author}
              </p>
            </div>
          </div>

          {/* Reading Progress */}
          <div className="space-y-2 mb-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--color-ink-muted)]">{book.chapterTitle}</span>
              <span className="font-medium text-[var(--color-gold)]">{book.progress}%</span>
            </div>
            <div className="continue-reading-progress-track">
              <div
                className="continue-reading-progress-fill"
                style={{ width: `${book.progress}%` }}
              />
            </div>
          </div>

          {/* Last Read Time */}
          <p className="text-xs text-[var(--color-ink-muted)] mb-4">
            Last read {formatRelativeTime(book.lastReadAt)}
          </p>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleResume}
              className="continue-reading-btn-resume flex-1"
              title="Resume reading with audio playback"
            >
              <PlayIcon />
              <span>Resume</span>
            </button>
            <button
              onClick={handleViewDetails}
              className="continue-reading-btn-details"
              title="View book details"
            >
              <InfoIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
