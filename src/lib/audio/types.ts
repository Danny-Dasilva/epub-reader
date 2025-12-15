/**
 * Audio playback and synchronization types
 */

import { WordTimestamp } from '../asr/types';

export interface SentenceAudio {
  sentenceId: string;
  text: string;
  audioBuffer?: AudioBuffer;  // Optional: created lazily if needed
  rawPcm: Float32Array;       // Raw PCM data for ASR processing
  sampleRate: number;         // Sample rate of the audio
  wavBuffer?: ArrayBuffer;    // Optimization #3: Pre-encoded WAV buffer from worker
  blobUrl?: string;           // WAV blob URL for HTMLAudioElement - created lazily for speed
  wordTimestamps: WordTimestamp[];
  duration: number;
  timestampSource: 'estimated' | 'asr';  // Track whether timestamps are estimated or ASR-verified
}

/**
 * Represents a sentence scheduled for gapless playback
 * Used by AudioPlayer to track pre-scheduled AudioBufferSourceNodes
 */
export interface ScheduledSentence {
  sentenceId: string;
  sourceNode: AudioBufferSourceNode;
  startTime: number;      // audioContext.currentTime when this sentence starts
  duration: number;       // Duration at current playbackRate
  sentence: SentenceAudio;
  wordTimestamps: WordTimestamp[];  // Copy for stability during playback
}

export interface PlaybackState {
  isPlaying: boolean;
  currentSentenceId: string | null;
  currentWordIndex: number | null;
  currentTime: number;
  duration: number;
}

export type PlaybackEventType =
  | 'play'
  | 'pause'
  | 'stop'
  | 'sentenceStart'
  | 'sentenceEnd'
  | 'wordChange'
  | 'scheduleMore'  // Request to schedule more look-ahead sentences
  | 'error';

export interface PlaybackEvent {
  type: PlaybackEventType;
  sentenceId?: string;
  wordIndex?: number;
  currentTime?: number;
  timestampSource?: 'estimated' | 'asr';  // Track if using accurate ASR timestamps
  error?: Error;
}

export type PlaybackEventHandler = (event: PlaybackEvent) => void;
