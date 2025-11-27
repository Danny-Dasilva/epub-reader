'use client';

import { memo, useCallback, useMemo } from 'react';
import { SentenceAudioState } from '@/store/readerStore';

interface TimelineProps {
  totalSentences: number;
  currentIndex: number;
  sentenceStates: Record<string, SentenceAudioState>;
  sentenceIds: string[];
  onSeek: (index: number) => void;
  estimatedDuration?: number; // in seconds
  currentTime?: number; // in seconds
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
  onSeek,
  estimatedDuration = 0,
  currentTime = 0
}: TimelineProps) {
  // Current playback position as percentage
  const playProgress = totalSentences > 0 ? ((currentIndex + 1) / totalSentences) * 100 : 0;

  // Calculate preload progress - count sentences that are ready, preloading, played, or playing
  const preloadStats = useMemo(() => {
    let preloadedCount = 0;
    let playedCount = 0;

    sentenceIds.forEach((id) => {
      const state = sentenceStates[id];
      if (state === 'ready' || state === 'preloading' || state === 'playing') {
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
      case 'ready':
      case 'preloading': return 'ready';
      case 'playing': return 'playing';
      default: return 'pending';
    }
  };

  return (
    <div className="timeline-container">
      <div
        className="timeline-track"
        onClick={handleTrackClick}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={totalSentences}
        aria-valuenow={currentIndex}
        tabIndex={0}
      >
        {/* Preload progress (subtle, shows % processed) */}
        <div
          className="timeline-preload"
          style={{ width: `${preloadStats.preloadPercentage}%` }}
        />

        {/* Played progress (purple, shows current position) */}
        <div
          className="timeline-progress"
          style={{ width: `${playProgress}%` }}
        />

        {/* Sentence markers */}
        <div className="timeline-markers">
          {visibleMarkers.map(({ id, index, position, state }) => (
            <button
              key={id}
              className={`timeline-marker ${getMarkerClass(state, index)}`}
              style={{ left: `${position}%` }}
              onClick={(e) => {
                e.stopPropagation();
                onSeek(index);
              }}
              title={`Sentence ${index + 1}`}
            />
          ))}
        </div>
      </div>

      <div className="timeline-time">
        <span>{formatTime(currentTime)}</span>
        <span>-{formatTime(Math.max(0, remainingTime))}</span>
      </div>
    </div>
  );
});
