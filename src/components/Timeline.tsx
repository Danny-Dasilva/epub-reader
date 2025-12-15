'use client';

import { memo, useCallback, useMemo, useState } from 'react';
import { SentenceAudioState } from '@/store/sentenceStateStore';

interface TimelineProps {
  totalSentences: number;
  currentIndex: number;
  sentenceStates: Record<string, SentenceAudioState>;
  sentenceIds: string[];
  asrCompletedIds: Set<string>;  // Sentences with ASR-refined timestamps
  onSeek: (index: number) => void;
  estimatedDuration?: number; // in seconds
  currentTime?: number; // in seconds
  enableASR?: boolean;  // Whether ASR is enabled (hides STT stat when false)
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const Timeline = memo(function Timeline({
  totalSentences,
  currentIndex,
  sentenceStates,
  sentenceIds,
  asrCompletedIds,
  onSeek,
  estimatedDuration = 0,
  currentTime = 0,
  enableASR = false
}: TimelineProps) {
  // Current playback position as percentage
  const playProgress = totalSentences > 0 ? ((currentIndex + 1) / totalSentences) * 100 : 0;

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Calculate preload progress - count sentences that are ready, preloading, played, or playing
  const preloadStats = useMemo(() => {
    let preloadedCount = 0;
    let playedCount = 0;

    sentenceIds.forEach((id) => {
      const state = sentenceStates[id];
      // Only count sentences with COMPLETED TTS generation (not 'preloading' which is just queued)
      if (state === 'ready' || state === 'playing') {
        preloadedCount++;
      }
      if (state === 'played') {
        playedCount++;
        preloadedCount++; // played also counts as preloaded
      }
    });

    const preloadPercentage = totalSentences > 0 ? (preloadedCount / totalSentences) * 100 : 0;
    const playedPercentage = totalSentences > 0 ? (playedCount / totalSentences) * 100 : 0;

    return { preloadedCount, playedCount, preloadPercentage, playedPercentage };
  }, [sentenceStates, sentenceIds, totalSentences]);

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

  const remainingTime = estimatedDuration - currentTime;

  const handleTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const targetIndex = Math.floor(percentage * totalSentences);
    onSeek(Math.max(0, Math.min(targetIndex, totalSentences - 1)));
  }, [totalSentences, onSeek]);

  // Calculate visible markers - show subset for performance
  const visibleMarkers = useMemo(() => {
    if (totalSentences <= 50) {
      // Show all markers if few sentences
      return sentenceIds.map((id, index) => ({
        id,
        index,
        position: ((index + 0.5) / totalSentences) * 100,
        state: sentenceStates[id] || 'pending'
      }));
    }

    // For many sentences, show sampled markers plus current and nearby
    const markers: { id: string; index: number; position: number; state: SentenceAudioState }[] = [];
    const step = Math.ceil(totalSentences / 30);

    for (let i = 0; i < totalSentences; i += step) {
      const id = sentenceIds[i];
      markers.push({
        id,
        index: i,
        position: ((i + 0.5) / totalSentences) * 100,
        state: sentenceStates[id] || 'pending'
      });
    }

    // Always include current and adjacent
    const nearby = [currentIndex - 1, currentIndex, currentIndex + 1].filter(
      i => i >= 0 && i < totalSentences
    );

    nearby.forEach(i => {
      if (!markers.some(m => m.index === i)) {
        const id = sentenceIds[i];
        markers.push({
          id,
          index: i,
          position: ((i + 0.5) / totalSentences) * 100,
          state: sentenceStates[id] || 'pending'
        });
      }
    });

    return markers.sort((a, b) => a.index - b.index);
  }, [totalSentences, sentenceIds, sentenceStates, currentIndex]);

  const getMarkerClass = (state: SentenceAudioState, index: number) => {
    if (index === currentIndex) return 'playing';
    switch (state) {
      case 'played': return 'played';
      case 'ready': return 'ready';
      case 'preloading': return 'preloading';
      case 'playing': return 'playing';
      default: return 'pending';
    }
  };

  return (
    <div className="timeline-container">
      <div
        className={`timeline-track segmented ${totalSentences > 60 ? 'dense' : ''}`}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={totalSentences}
        aria-valuenow={currentIndex}
        tabIndex={0}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        {sentenceIds.map((id, index) => {
          const state = sentenceStates[id] || 'pending';
          const isPlayed = index < currentIndex;
          const isCurrent = index === currentIndex;
          const hasASR = asrCompletedIds.has(id);

          // Priority: active > played > asr > ready > preloading > pending
          let segmentClass = 'timeline-segment';
          if (isCurrent) segmentClass += ' active';
          else if (isPlayed) segmentClass += ' played';
          else if (hasASR && (state === 'ready' || state === 'playing')) segmentClass += ' asr';
          else if (state === 'ready') segmentClass += ' ready';
          else if (state === 'preloading') segmentClass += ' preloading';
          else segmentClass += ' pending';

          return (
            <div
              key={id}
              className={segmentClass}
              onClick={(e) => {
                e.stopPropagation();
                onSeek(index);
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              title={undefined} // Disable native title to use custom tooltip
            />
          );
        })}
      </div>

      {hoveredIndex !== null && (
        <div
          className="timeline-tooltip"
          style={{
            left: `${((hoveredIndex + 0.5) / totalSentences) * 100}%`,
            transform: 'translateX(-50%)'
          }}
        >
          <div className="tooltip-content">
            <span className="tooltip-label">Sentence</span>
            <span className="tooltip-value">{hoveredIndex + 1} <span className="tooltip-separator">/</span> {totalSentences}</span>
          </div>
        </div>
      )}

      <div className="timeline-stats">
        <div className="stat-item played">
          <span className="stat-label">Played</span>
          <span className="stat-value">
            {preloadStats.playedCount}/{totalSentences} ({Math.round(preloadStats.playedPercentage)}%)
          </span>
        </div>
        <div className="stat-item ready">
          <span className="stat-label">TTS</span>
          <span className="stat-value">
            {preloadStats.preloadedCount}/{totalSentences} ({Math.round(preloadStats.preloadPercentage)}%)
          </span>
        </div>
        {enableASR && (
          <div className="stat-item asr">
            <span className="stat-label">STT</span>
            <span className="stat-value">
              {asrStats.asrCount}/{totalSentences} ({Math.round(asrStats.asrPercentage)}%)
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
