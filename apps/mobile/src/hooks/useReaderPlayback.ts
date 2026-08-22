import { useCallback, useEffect, useRef, useState } from 'react';

import { ExpoAudioOutput } from '@/lib/audio/ExpoAudioOutput';
import {
  PlaybackCoordinator,
  type PlaybackState,
} from '@/lib/playback/PlaybackCoordinator';
import { libraryRepository } from '@/lib/storage/libraryRepository';
import { InflectSynthesizer } from '@/lib/tts/InflectSynthesizer';
import type { ModelDownloadProgress } from '@/lib/tts/modelManager';
import type { ReaderBook, ReaderPosition } from '@/types/reader';

const initialPlaybackState = (position: ReaderPosition): PlaybackState => ({
  ...position,
  isPlaying: false,
  isLoading: false,
  activeSentenceId: null,
  currentWordIndex: null,
  positionSeconds: 0,
  durationSeconds: 0,
  speechRate: 1,
  error: null,
});

export function useReaderPlayback(book: ReaderBook | null, initialPosition: ReaderPosition) {
  const [state, setState] = useState(() => initialPlaybackState(initialPosition));
  const [modelProgress, setModelProgress] = useState<ModelDownloadProgress | null>(null);
  const coordinatorRef = useRef<PlaybackCoordinator | null>(null);

  useEffect(() => {
    if (!book) return;
    const synthesizer = new InflectSynthesizer(setModelProgress);
    const coordinator = new PlaybackCoordinator(synthesizer, new ExpoAudioOutput(), setState);
    coordinatorRef.current = coordinator;
    coordinator.setBook(book, initialPosition);
    return () => {
      coordinator.release();
      coordinatorRef.current = null;
    };
  }, [book, initialPosition]);

  useEffect(() => {
    if (!book) return;
    void libraryRepository.saveProgress(book.id, {
      chapterIndex: state.chapterIndex,
      sentenceIndex: state.sentenceIndex,
    });
  }, [book, state.chapterIndex, state.sentenceIndex]);

  const toggle = useCallback(() => coordinatorRef.current?.toggle(), []);
  const next = useCallback(() => coordinatorRef.current?.next(), []);
  const previous = useCallback(() => coordinatorRef.current?.previous(), []);
  const selectSentence = useCallback(
    (sentenceIndex: number) => coordinatorRef.current?.selectSentence(sentenceIndex),
    [],
  );
  const selectChapter = useCallback(
    (chapterIndex: number) => coordinatorRef.current?.selectChapter(chapterIndex),
    [],
  );
  const setSpeechRate = useCallback(
    (rate: number) => coordinatorRef.current?.setSpeechRate(rate),
    [],
  );

  return {
    state,
    modelProgress,
    toggle,
    next,
    previous,
    selectSentence,
    selectChapter,
    setSpeechRate,
  };
}
