'use client';

import { memo, useState, useCallback, useEffect, useRef } from 'react';

interface PlaybackControlsProps {
  isPlaying: boolean;
  playbackSpeed: number;
  ttsLoading: boolean;
  ttsReady: boolean;
  onPlayPause: () => void;
  onSkipBack: () => void;
  onSkipForward: () => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onSpeedChange: (speed: number) => void;
  onSettingsOpen: () => void;
  canGoPrevChapter: boolean;
  canGoNextChapter: boolean;
}

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

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

const ChapterBackIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
  </svg>
);

const ChapterForwardIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z" />
  </svg>
);

const SkipBackIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" fill="currentColor" stroke="none" />
    <text x="9" y="15" fontSize="7" fontWeight="bold" fill="var(--bg)" stroke="none">15</text>
  </svg>
);

const SkipForwardIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" fill="currentColor" stroke="none" />
    <text x="9" y="15" fontSize="7" fontWeight="bold" fill="var(--bg)" stroke="none">15</text>
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
  onSkipBack,
  onSkipForward,
  onPrevChapter,
  onNextChapter,
  onSpeedChange,
  onSettingsOpen,
  canGoPrevChapter,
  canGoNextChapter
}: PlaybackControlsProps) {
  const [showSpeedPopup, setShowSpeedPopup] = useState(false);
  const speedBtnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Handle click outside to close popup
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        showSpeedPopup &&
        popupRef.current &&
        speedBtnRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        !speedBtnRef.current.contains(e.target as Node)
      ) {
        setShowSpeedPopup(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSpeedPopup]);

  const handleSpeedSelect = useCallback((speed: number) => {
    onSpeedChange(speed);
    setShowSpeedPopup(false);
  }, [onSpeedChange]);

  const formatSpeed = (speed: number) => {
    return speed === 1 ? '1x' : `${speed}x`;
  };

  return (
    <div className="playback-controls">
      {/* Speed button with popup */}
      <div className="speed-btn-container">
        <button
          ref={speedBtnRef}
          className="playback-btn speed-btn"
          onClick={() => setShowSpeedPopup(!showSpeedPopup)}
          title={`Speed: ${formatSpeed(playbackSpeed)}`}
        >
          {formatSpeed(playbackSpeed)}
        </button>

        {/* Speed Popup */}
        {showSpeedPopup && (
          <div ref={popupRef} className="speed-popup">
            {SPEEDS.slice().reverse().map((speed) => (
              <button
                key={speed}
                className={`speed-popup-option ${playbackSpeed === speed ? 'active' : ''}`}
                onClick={() => handleSpeedSelect(speed)}
              >
                {formatSpeed(speed)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Previous chapter */}
      <button
        className="playback-btn"
        onClick={onPrevChapter}
        disabled={!canGoPrevChapter}
        title="Previous chapter"
      >
        <ChapterBackIcon />
      </button>

      {/* Skip back 15s */}
      <button
        className="playback-btn skip-btn"
        onClick={onSkipBack}
        title="Skip back 15 seconds"
      >
        <span className="skip-label">-15</span>
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

      {/* Skip forward 15s */}
      <button
        className="playback-btn skip-btn"
        onClick={onSkipForward}
        title="Skip forward 15 seconds"
      >
        <span className="skip-label">+15</span>
      </button>

      {/* Next chapter */}
      <button
        className="playback-btn"
        onClick={onNextChapter}
        disabled={!canGoNextChapter}
        title="Next chapter"
      >
        <ChapterForwardIcon />
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
