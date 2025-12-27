'use client';

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { SentenceAudioState, useDebouncedSentenceStates } from '@/store/sentenceStateStore';
import { TimelineStats } from './TimelineStats';
import { TimeEstimate } from '@/hooks/useTimeEstimation';

interface TimelineProps {
  totalSentences: number;
  currentIndex: number;
  sentenceIds: string[];
  asrCompletedIds: Set<string>;  // Sentences with ASR-refined timestamps
  onSeek: (index: number) => void;
  estimatedDuration?: number; // in seconds
  currentTime?: number; // in seconds
  enableASR?: boolean;  // Whether ASR is enabled (hides STT stat when false)
  bookProgress?: number; // 0-100 percentage of book completion
  timeEstimate?: TimeEstimate; // Time estimation data
  isPlaying?: boolean; // Whether playback is active
}

// Optimization #4: Segment colors with opacity baked in for CSS gradient
// These are fixed colors that match the theme - CSS variables don't work well in gradients
const SEGMENT_COLORS = {
  pending: 'rgba(102, 102, 102, 0.2)',      // --text-muted at 0.2
  preloading: 'rgba(249, 115, 22, 0.25)',   // orange-500 at 0.25
  ready: 'rgba(249, 115, 22, 0.6)',         // orange-500 at 0.6
  asr: 'rgba(110, 231, 183, 0.7)',          // --highlight-word-asr at 0.7
  played: 'rgba(168, 85, 247, 0.5)',        // --accent-purple at 0.5
  active: 'rgba(168, 85, 247, 1)',          // --accent-purple at 1.0
  playing: 'rgba(168, 85, 247, 1)',         // same as active
};

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get the color for a segment based on its state
 * Priority: active > played > asr > ready > preloading > pending
 */
function getSegmentColor(
  state: SentenceAudioState | undefined,
  index: number,
  currentIndex: number,
  hasASR: boolean
): string {
  if (index === currentIndex) return SEGMENT_COLORS.active;
  if (index < currentIndex) return SEGMENT_COLORS.played;
  if (hasASR && (state === 'ready' || state === 'playing')) return SEGMENT_COLORS.asr;
  if (state === 'ready') return SEGMENT_COLORS.ready;
  if (state === 'preloading') return SEGMENT_COLORS.preloading;
  return SEGMENT_COLORS.pending;
}

export const Timeline = memo(function Timeline({
  totalSentences,
  currentIndex,
  sentenceIds,
  asrCompletedIds,
  onSeek,
  estimatedDuration = 0,
  currentTime = 0,
  enableASR = false,
  bookProgress = 0,
  timeEstimate,
  isPlaying = false
}: TimelineProps) {
  // Optimization #5: Use debounced sentence states to reduce re-renders during rapid preloading
  // This reduces render frequency from ~20/sec to ~6/sec while still providing responsive feedback
  const sentenceStates = useDebouncedSentenceStates(150);

  const trackRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Calculate preload progress - count sentences that are ready, preloading, played, or playing
  const preloadStats = useMemo(() => {
    let preloadedCount = 0;

    sentenceIds.forEach((id) => {
      const state = sentenceStates[id];
      // Only count sentences with COMPLETED TTS generation (not 'preloading' which is just queued)
      if (state === 'ready' || state === 'playing' || state === 'played') {
        preloadedCount++;
      }
    });

    const preloadPercentage = totalSentences > 0 ? (preloadedCount / totalSentences) * 100 : 0;

    return { preloadedCount, preloadPercentage };
  }, [sentenceStates, sentenceIds, totalSentences]);

  // Position-based played count - all sentences before currentIndex are considered "played"
  const playedCount = currentIndex;
  const playedPercentage = totalSentences > 0 ? (playedCount / totalSentences) * 100 : 0;

  // Calculate ASR progress - sentences with refined word timestamps
  const asrStats = useMemo(() => {
    let asrCount = 0;
    sentenceIds.forEach((id) => {
      if (asrCompletedIds.has(id)) {
        asrCount++;
      }
    });
    const asrPercentage = totalSentences > 0 ? (asrCount / totalSentences) * 100 : 0;
    return { asrCount, asrPercentage };
  }, [asrCompletedIds, sentenceIds, totalSentences]);

  // Get state info for a sentence (used for tooltip state indicator)
  const getSentenceStateInfo = useCallback((index: number): { color: string; label: string } | null => {
    if (index < 0 || index >= sentenceIds.length) return null;
    const id = sentenceIds[index];
    const state = sentenceStates[id];
    const hasASR = asrCompletedIds.has(id);

    if (index === currentIndex) return { color: SEGMENT_COLORS.active, label: 'Playing' };
    if (index < currentIndex) return { color: SEGMENT_COLORS.played, label: 'Played' };
    if (hasASR) return { color: SEGMENT_COLORS.asr, label: 'ASR Ready' };
    if (state === 'ready' || state === 'playing') return { color: SEGMENT_COLORS.ready, label: 'TTS Ready' };
    if (state === 'preloading') return { color: SEGMENT_COLORS.preloading, label: 'Loading' };
    return { color: SEGMENT_COLORS.pending, label: 'Pending' };
  }, [sentenceIds, sentenceStates, asrCompletedIds, currentIndex]);

  // Optimization #4: Build CSS gradient from sentence states
  // This replaces 500+ DOM elements with a single gradient
  const gradientBackground = useMemo(() => {
    if (totalSentences === 0) return 'transparent';

    const stops: string[] = [];
    let lastColor = '';
    let runStart = 0;

    // Build gradient by coalescing adjacent segments with same color
    for (let i = 0; i < totalSentences; i++) {
      const id = sentenceIds[i];
      const state = sentenceStates[id];
      const hasASR = asrCompletedIds.has(id);
      const color = getSegmentColor(state, i, currentIndex, hasASR);

      if (color !== lastColor) {
        if (lastColor) {
          // End previous color run
          const endPct = (i / totalSentences) * 100;
          stops.push(`${lastColor} ${runStart.toFixed(2)}% ${endPct.toFixed(2)}%`);
        }
        lastColor = color;
        runStart = (i / totalSentences) * 100;
      }
    }

    // Add final color run
    if (lastColor) {
      stops.push(`${lastColor} ${runStart.toFixed(2)}% 100%`);
    }

    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [sentenceIds, sentenceStates, asrCompletedIds, currentIndex, totalSentences]);

  // Current sentence marker position
  const markerPosition = totalSentences > 0
    ? ((currentIndex + 0.5) / totalSentences) * 100
    : 0;

  // Calculate index from mouse position
  const getIndexFromEvent = useCallback((e: React.MouseEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    return Math.floor(percentage * totalSentences);
  }, [totalSentences]);

  const handleTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const targetIndex = getIndexFromEvent(e);
    onSeek(Math.max(0, Math.min(targetIndex, totalSentences - 1)));
  }, [getIndexFromEvent, onSeek, totalSentences]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const index = getIndexFromEvent(e);
    if (index >= 0 && index < totalSentences) {
      setHoveredIndex(index);
    }
  }, [getIndexFromEvent, totalSentences]);

  const handleMouseLeave = useCallback(() => {
    setHoveredIndex(null);
  }, []);

  return (
    <div className="timeline-container">
      <div
        ref={trackRef}
        className={`timeline-track segmented ${totalSentences > 60 ? 'dense' : ''}`}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={totalSentences}
        aria-valuenow={currentIndex}
        tabIndex={0}
        onClick={handleTrackClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Optimization #4: Single gradient div instead of 500+ segment divs */}
        <div
          className="timeline-gradient"
          style={{ background: gradientBackground }}
        >
          {/* Current sentence marker */}
          {totalSentences > 0 && (
            <div
              className="timeline-gradient-marker"
              style={{ left: `${markerPosition}%` }}
            />
          )}
        </div>
      </div>

      {hoveredIndex !== null && (() => {
        const stateInfo = getSentenceStateInfo(hoveredIndex);
        return (
          <div
            className="timeline-tooltip"
            style={{
              left: `${((hoveredIndex + 0.5) / totalSentences) * 100}%`,
              transform: 'translateX(-50%)'
            }}
          >
            <div className="tooltip-content">
              {stateInfo && (
                <span
                  className="tooltip-state-dot"
                  style={{ background: stateInfo.color }}
                />
              )}
              <span className="tooltip-label">{stateInfo?.label ?? 'Sentence'}</span>
              <span className="tooltip-separator">•</span>
              <span className="tooltip-value">{hoveredIndex + 1} / {totalSentences}</span>
            </div>
          </div>
        );
      })()}

      <TimelineStats
        playedCount={playedCount}
        totalSentences={totalSentences}
        playedPercentage={playedPercentage}
        preloadedCount={preloadStats.preloadedCount}
        preloadPercentage={preloadStats.preloadPercentage}
        asrCount={asrStats.asrCount}
        asrPercentage={asrStats.asrPercentage}
        enableASR={enableASR}
        bookProgress={bookProgress}
        currentTime={currentTime}
        estimatedDuration={estimatedDuration}
        timeEstimate={timeEstimate}
        isPlaying={isPlaying}
      />
    </div>
  );
});
