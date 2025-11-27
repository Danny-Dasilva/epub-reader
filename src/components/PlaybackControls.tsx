'use client';

import { memo, useCallback } from 'react';

interface PlaybackControlsProps {
  isPlaying: boolean;
  playbackSpeed: number;
  ttsLoading: boolean;
  ttsReady: boolean;
  onPlayPause: () => void;
  onPrevSentence: () => void;
  onNextSentence: () => void;
  onSpeedChange: (speed: number) => void;
  onSettingsOpen: () => void;
}

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

// Icons
const PlayIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
  </svg>
);

const SkipBackIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="19 20 9 12 19 4 19 20" fill="currentColor" />
    <line x1="5" y1="19" x2="5" y2="5" />
  </svg>
);

const SkipForwardIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 4 15 12 5 20 5 4" fill="currentColor" />
    <line x1="19" y1="5" x2="19" y2="19" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </svg>
);

export const PlaybackControls = memo(function PlaybackControls({
  isPlaying,
  playbackSpeed,
  ttsLoading,
  ttsReady,
  onPlayPause,
  onPrevSentence,
  onNextSentence,
  onSpeedChange,
  onSettingsOpen
}: PlaybackControlsProps) {
  // Cycle through speeds on tap
  const handleSpeedClick = useCallback(() => {
    const currentIndex = SPEEDS.indexOf(playbackSpeed);
    const nextIndex = (currentIndex + 1) % SPEEDS.length;
    onSpeedChange(SPEEDS[nextIndex]);
  }, [playbackSpeed, onSpeedChange]);

  const formatSpeed = (speed: number) => {
    return speed === 1 ? '1x' : `${speed}x`;
  };

  return (
    <div className="playback-controls">
      {/* Speed button */}
      <button
        className="playback-btn speed-btn"
        onClick={handleSpeedClick}
        title={`Speed: ${formatSpeed(playbackSpeed)}`}
      >
        {formatSpeed(playbackSpeed)}
      </button>

      {/* Skip back */}
      <button
        className="playback-btn"
        onClick={onPrevSentence}
        title="Previous sentence"
      >
        <SkipBackIcon />
      </button>

      {/* Play/Pause - Primary button */}
      <button
        className="playback-btn primary"
        onClick={onPlayPause}
        disabled={!ttsReady && !ttsLoading}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {ttsLoading ? (
          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : isPlaying ? (
          <PauseIcon />
        ) : (
          <PlayIcon />
        )}
      </button>

      {/* Skip forward */}
      <button
        className="playback-btn"
        onClick={onNextSentence}
        title="Next sentence"
      >
        <SkipForwardIcon />
      </button>

      {/* Settings */}
      <button
        className="playback-btn"
        onClick={onSettingsOpen}
        title="Settings"
      >
        <SettingsIcon />
      </button>
    </div>
  );
});
