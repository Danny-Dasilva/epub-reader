'use client';

import { memo } from 'react';
import { SleepTimerPreset } from '@/store/sleepTimerStore';

interface SleepTimerControlProps {
  isActive: boolean;
  remainingFormatted: string;
  selectedPreset: SleepTimerPreset | null;
  onStart: (preset: SleepTimerPreset) => void;
  onStop: () => void;
}

const PRESET_OPTIONS: Array<{ value: SleepTimerPreset; label: string }> = [
  { value: 5, label: '5m' },
  { value: 10, label: '10m' },
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
  { value: 45, label: '45m' },
  { value: 60, label: '60m' },
  { value: 'chapter_end', label: 'Chapter' }
];

const ClockIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

export const SleepTimerControl = memo(function SleepTimerControl({
  isActive,
  remainingFormatted,
  selectedPreset,
  onStart,
  onStop
}: SleepTimerControlProps) {
  return (
    <div className="sleep-timer-control">
      {!isActive ? (
        <>
          {/* Preset selection grid */}
          <div className="sleep-timer-presets">
            {PRESET_OPTIONS.map((preset) => (
              <button
                key={preset.value}
                className="sleep-timer-preset-btn"
                onClick={() => onStart(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Active timer display */}
          <div className="sleep-timer-active">
            <div className="sleep-timer-active-content">
              <div className="sleep-timer-icon">
                <ClockIcon />
              </div>
              <div className="sleep-timer-info">
                <div className="sleep-timer-label">Sleep Timer</div>
                <div className="sleep-timer-countdown">{remainingFormatted}</div>
              </div>
            </div>
            <button
              className="sleep-timer-cancel-btn"
              onClick={onStop}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
});
