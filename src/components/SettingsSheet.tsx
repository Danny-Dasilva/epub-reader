'use client';

import { memo, useEffect, useCallback } from 'react';
import { Chapter } from '@/lib/epub';
import { useUIStore, ScrollPosition } from '@/store/uiStore';
import { usePlaybackStore } from '@/store/playbackStore';

interface SettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  // Voice
  currentVoice: string;
  onVoiceChange: (voice: string) => void;
  // Volume
  volume: number;
  onVolumeChange: (volume: number) => void;
  // Speed controls
  speechRate: number;
  onSpeechRateChange: (rate: number) => void;
  audioPlaybackRate: number;
  onAudioPlaybackRateChange: (rate: number) => void;
  // Chapters
  chapters: Chapter[];
  currentChapterIndex: number;
  onChapterSelect: (index: number) => void;
}

const VOICES = ['M1', 'M2', 'F1', 'F2'] as const;

const VolumeIcon = ({ muted }: { muted?: boolean }) => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
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

const SPEECH_RATE_PRESETS = [0.9, 1.0, 1.05, 1.1, 1.2] as const;
const PLAYBACK_RATE_PRESETS = [0.75, 1.0, 1.25, 1.5, 2.0] as const;

export const SettingsSheet = memo(function SettingsSheet({
  isOpen,
  onClose,
  currentVoice,
  onVoiceChange,
  volume,
  onVolumeChange,
  speechRate,
  onSpeechRateChange,
  audioPlaybackRate,
  onAudioPlaybackRateChange,
  chapters,
  currentChapterIndex,
  onChapterSelect
}: SettingsSheetProps) {
  // Auto-scroll settings from store
  const autoScroll = useUIStore((state) => state.autoScroll);
  const scrollPosition = useUIStore((state) => state.scrollPosition);
  const setAutoScroll = useUIStore((state) => state.setAutoScroll);
  const setScrollPosition = useUIStore((state) => state.setScrollPosition);

  // Background playback settings from store
  const allowBackgroundPlayback = usePlaybackStore((state) => state.allowBackgroundPlayback);
  const setAllowBackgroundPlayback = usePlaybackStore((state) => state.setAllowBackgroundPlayback);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const handleChapterClick = useCallback((index: number) => {
    onChapterSelect(index);
    onClose();
  }, [onChapterSelect, onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        className={`settings-sheet-overlay ${isOpen ? 'open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        className={`settings-sheet ${isOpen ? 'open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="settings-sheet-handle" />

        <div className="settings-sheet-content">
          {/* Voice Selection */}
          <div className="settings-section">
            <h3 className="settings-section-title">Voice</h3>
            <div className="settings-row">
              {VOICES.map((voice) => (
                <button
                  key={voice}
                  className={`settings-pill ${currentVoice === voice ? 'active' : ''}`}
                  onClick={() => onVoiceChange(voice)}
                >
                  {voice}
                </button>
              ))}
            </div>
          </div>

          {/* Auto-Scroll */}
          <div className="settings-section">
            <h3 className="settings-section-title">Auto-Scroll</h3>
            <div className="settings-row justify-between">
              <span className="text-sm text-[var(--text-muted)]">Follow current sentence</span>
              <button
                className={`toggle-switch ${autoScroll ? 'active' : ''}`}
                onClick={() => setAutoScroll(!autoScroll)}
                role="switch"
                aria-checked={autoScroll}
              >
                <span className="toggle-switch-thumb" />
              </button>
            </div>
            {autoScroll && (
              <div className="settings-row mt-2">
                <span className="text-xs text-[var(--text-muted)] mr-3">Position:</span>
                {(['top', 'center'] as const).map((pos) => (
                  <button
                    key={pos}
                    className={`settings-pill ${scrollPosition === pos ? 'active' : ''}`}
                    onClick={() => setScrollPosition(pos)}
                  >
                    {pos.charAt(0).toUpperCase() + pos.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Background Playback */}
          <div className="settings-section">
            <h3 className="settings-section-title">Background Playback</h3>
            <div className="settings-row justify-between">
              <div>
                <span className="text-sm text-[var(--text-muted)]">Continue when tab hidden</span>
                <p className="text-xs text-[var(--text-muted)] opacity-70 mt-0.5">
                  Enables lock screen controls
                </p>
              </div>
              <button
                className={`toggle-switch ${allowBackgroundPlayback ? 'active' : ''}`}
                onClick={() => setAllowBackgroundPlayback(!allowBackgroundPlayback)}
                role="switch"
                aria-checked={allowBackgroundPlayback}
              >
                <span className="toggle-switch-thumb" />
              </button>
            </div>
          </div>

          {/* Volume */}
          <div className="settings-section">
            <h3 className="settings-section-title">Volume</h3>
            <div className="settings-row">
              <button
                className="playback-btn"
                onClick={() => onVolumeChange(volume === 0 ? 1 : 0)}
                title={volume === 0 ? 'Unmute' : 'Mute'}
              >
                <VolumeIcon muted={volume === 0} />
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                className="volume-slider"
                title={`Volume: ${Math.round(volume * 100)}%`}
              />
              <span className="text-sm text-[var(--text-muted)] min-w-[3rem] text-right">
                {Math.round(volume * 100)}%
              </span>
            </div>
          </div>

          {/* TTS Generation Speed */}
          <div className="settings-section">
            <h3 className="settings-section-title">TTS Speed</h3>
            <p className="text-xs text-[var(--text-muted)] mb-2">How fast the model generates speech (clears cache)</p>
            <div className="settings-row">
              {SPEECH_RATE_PRESETS.map((rate) => (
                <button
                  key={rate}
                  className={`settings-pill ${speechRate === rate ? 'active' : ''}`}
                  onClick={() => onSpeechRateChange(rate)}
                >
                  {rate}x
                </button>
              ))}
            </div>
          </div>

          {/* Audio Playback Speed */}
          <div className="settings-section">
            <h3 className="settings-section-title">Playback Speed</h3>
            <p className="text-xs text-[var(--text-muted)] mb-2">How fast audio plays back (instant)</p>
            <div className="settings-row">
              {PLAYBACK_RATE_PRESETS.map((rate) => (
                <button
                  key={rate}
                  className={`settings-pill ${audioPlaybackRate === rate ? 'active' : ''}`}
                  onClick={() => onAudioPlaybackRateChange(rate)}
                >
                  {rate}x
                </button>
              ))}
            </div>
          </div>

          {/* Chapters */}
          <div className="settings-section">
            <h3 className="settings-section-title">Chapters</h3>
            <div className="chapter-list">
              {chapters.map((chapter, index) => (
                <button
                  key={chapter.id}
                  className={`chapter-item ${index === currentChapterIndex ? 'active' : ''}`}
                  onClick={() => handleChapterClick(index)}
                >
                  <span className="chapter-item-number">{index + 1}</span>
                  <span className="truncate flex-1">{chapter.title}</span>
                  {index === currentChapterIndex && (
                    <span className="w-2 h-2 rounded-full bg-[var(--accent,var(--color-accent-purple))]" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
});
