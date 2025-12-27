'use client';

import { memo, useState } from 'react';
import { TimeEstimate } from '@/hooks/useTimeEstimation';

interface TimelineStatsProps {
  playedCount: number;
  totalSentences: number;
  playedPercentage: number;
  preloadedCount: number;
  preloadPercentage: number;
  asrCount?: number;
  asrPercentage?: number;
  enableASR?: boolean;
  bookProgress: number;
  currentTime: number;
  estimatedDuration: number;
  timeEstimate?: TimeEstimate;
  isPlaying?: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const TimelineStats = memo(function TimelineStats({
  playedCount,
  totalSentences,
  playedPercentage,
  preloadedCount,
  preloadPercentage,
  asrCount,
  asrPercentage,
  enableASR = false,
  bookProgress,
  currentTime,
  estimatedDuration,
  timeEstimate,
  isPlaying = false
}: TimelineStatsProps) {
  const [expanded, setExpanded] = useState(false);

  // Check if we're on mobile based on screen width
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  return (
    <div className="timeline-stats-container">
      {/* Mobile View - Collapsible */}
      {isMobile ? (
        <>
          <button
            className="timeline-stats-mobile-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse stats' : 'Expand stats'}
          >
            <div className="timeline-stats-mobile-primary">
              {timeEstimate && timeEstimate.bookRemaining.ms > 0 ? (
                <span className="stat-primary-item">
                  <span className="stat-primary-label">Remaining:</span>
                  <span className="stat-primary-value">~{timeEstimate.bookRemaining.formatted}</span>
                </span>
              ) : null}
              <span className="stat-primary-item">
                <span className="stat-primary-label">Progress:</span>
                <span className="stat-primary-value">{Math.round(playedPercentage)}%</span>
              </span>
            </div>
            <svg
              className={`timeline-stats-mobile-chevron ${expanded ? 'expanded' : ''}`}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {expanded && (
            <div className="timeline-stats-mobile-expanded">
              {timeEstimate && (
                <>
                  {timeEstimate.chapterRemaining.ms > 0 && (
                    <div className="stat-item">
                      <span className="stat-label">Chapter Left</span>
                      <span className="stat-value">~{timeEstimate.chapterRemaining.formatted}</span>
                    </div>
                  )}
                  {timeEstimate.bookRemaining.ms > 0 && (
                    <div className="stat-item">
                      <span className="stat-label">Book Left</span>
                      <span className="stat-value">~{timeEstimate.bookRemaining.formatted}</span>
                    </div>
                  )}
                  {isPlaying && timeEstimate.estimatedFinishTime && (
                    <div className="stat-item">
                      <span className="stat-label">Finish At</span>
                      <span className="stat-value">
                        {timeEstimate.estimatedFinishTime.toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </span>
                    </div>
                  )}
                  <div className="stat-item">
                    <span className="stat-label">Reading Pace</span>
                    <span className="stat-value">
                      {timeEstimate.readingPace.sentencesPerMinute.toFixed(1)} sent/min
                    </span>
                  </div>
                </>
              )}
              <div className="stat-item played">
                <span className="stat-label">Played</span>
                <span className="stat-value">
                  {playedCount}/{totalSentences} ({Math.round(playedPercentage)}%)
                </span>
              </div>
              <div className="stat-item time">
                <span className="stat-label">Time</span>
                <span className="stat-value">
                  {formatTime(currentTime)} / ~{formatTime(estimatedDuration)}
                </span>
              </div>
              <div className="stat-item ready">
                <span className="stat-label">TTS</span>
                <span className="stat-value">
                  {preloadedCount}/{totalSentences} ({Math.round(preloadPercentage)}%)
                </span>
              </div>
              {enableASR && asrCount !== undefined && asrPercentage !== undefined && (
                <div className="stat-item asr">
                  <span className="stat-label">STT</span>
                  <span className="stat-value">
                    {asrCount}/{totalSentences} ({Math.round(asrPercentage)}%)
                  </span>
                </div>
              )}
              <div className="stat-item book">
                <span className="stat-label">Book</span>
                <span className="stat-value">{bookProgress.toFixed(1)}%</span>
              </div>
            </div>
          )}
        </>
      ) : (
        /* Desktop View - Inline */
        <div className="timeline-stats-desktop">
          {timeEstimate && timeEstimate.bookRemaining.ms > 0 && (
            <div className="stat-item remaining">
              <span className="stat-label">Remaining</span>
              <span className="stat-value">~{timeEstimate.bookRemaining.formatted}</span>
            </div>
          )}
          {timeEstimate && timeEstimate.chapterRemaining.ms > 0 && (
            <div className="stat-item chapter">
              <span className="stat-label">Chapter</span>
              <span className="stat-value">~{timeEstimate.chapterRemaining.formatted}</span>
            </div>
          )}
          <div className="stat-item played">
            <span className="stat-label">Played</span>
            <span className="stat-value">
              {playedCount}/{totalSentences}
            </span>
          </div>
          <div className="stat-item book">
            <span className="stat-label">Book</span>
            <span className="stat-value">{bookProgress.toFixed(1)}%</span>
          </div>
          <div className="stat-item time">
            <span className="stat-value">
              {formatTime(currentTime)} / ~{formatTime(estimatedDuration)}
            </span>
          </div>
          <div className="stat-item ready">
            <span className="stat-label">TTS</span>
            <span className="stat-value">
              {preloadedCount}/{totalSentences}
            </span>
          </div>
          {enableASR && asrCount !== undefined && asrPercentage !== undefined && (
            <div className="stat-item asr">
              <span className="stat-label">STT</span>
              <span className="stat-value">
                {asrCount}/{totalSentences}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
