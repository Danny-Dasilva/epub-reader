/**
 * Audio playback and synchronization types
 */

import { WordTimestamp } from '../asr/types';

export interface SentenceAudio {
  sentenceId: string;
  text: string;
  audioBuffer: AudioBuffer;
  blobUrl: string;  // WAV blob URL for HTMLAudioElement playback with preservesPitch
  wordTimestamps: WordTimestamp[];
  duration: number;
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
  | 'error';

export interface PlaybackEvent {
  type: PlaybackEventType;
  sentenceId?: string;
  wordIndex?: number;
  currentTime?: number;
  error?: Error;
}

export type PlaybackEventHandler = (event: PlaybackEvent) => void;
