'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useReaderStore } from '@/store/readerStore';
import {
  AudioSyncService,
  initializeAudioSyncService,
  PlaybackEvent
} from '@/lib/audio';
import { Sentence } from '@/lib/epub';

const TTS_MODEL_PATH = '/models/tts';

// Map voice names to file paths
const VOICE_PATHS: Record<string, string> = {
  'M1': '/voice_styles/M1.json',
  'M2': '/voice_styles/M2.json',
  'F1': '/voice_styles/F1.json',
  'F2': '/voice_styles/F2.json',
};

/**
 * Session for tracking current playback context
 * Allows cancellation when user changes actions
 */
interface PlaybackSession {
  abortController: AbortController;
  sentenceId: string | null;
  chapterIndex: number;
}

export function useAudioPlayback() {
  const serviceRef = useRef<AudioSyncService | null>(null);
  const [initProgress, setInitProgress] = useState(0);
  const [initMessage, setInitMessage] = useState('');

  // Session for tracking current playback and enabling cancellation
  const sessionRef = useRef<PlaybackSession>({
    abortController: new AbortController(),
    sentenceId: null,
    chapterIndex: 0
  });

  // Refs for tracking pause/resume state (avoid stale closures)
  const isPausedRef = useRef(false);
  const handlePlaybackEventRef = useRef<(event: PlaybackEvent) => void>(() => {});

  const {
    currentBook,
    currentChapterIndex,
    currentSentenceIndex,
    isPlaying,
    volume,
    speechRate,
    audioPlaybackRate,
    currentVoice,
    setIsPlaying,
    setTTSReady,
    setTTSLoading,
    setTTSBackend,
    setHighlight,
    setSentenceState,
    clearSentenceStates,
    nextSentence,
    getCurrentChapter,
    getCurrentSentence
  } = useReaderStore();

  /**
   * Create a new session, cancelling any existing one
   */
  const newSession = useCallback((sentenceId: string | null = null): PlaybackSession => {
    // Abort the existing session
    sessionRef.current.abortController.abort();

    // Create new session
    const session: PlaybackSession = {
      abortController: new AbortController(),
      sentenceId,
      chapterIndex: currentChapterIndex
    };
    sessionRef.current = session;

    return session;
  }, [currentChapterIndex]);

  /**
   * Cancel current session without creating a new one
   */
  const cancelSession = useCallback(() => {
    sessionRef.current.abortController.abort();
    sessionRef.current = {
      abortController: new AbortController(),
      sentenceId: null,
      chapterIndex: currentChapterIndex
    };
  }, [currentChapterIndex]);

  // Initialize audio service
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (serviceRef.current) return;

      setTTSLoading(true);
      setInitProgress(0);
      setInitMessage('Initializing...');

      try {
        const voicePath = VOICE_PATHS[currentVoice] || VOICE_PATHS['M1'];

        const service = initializeAudioSyncService({
          ttsModelPath: TTS_MODEL_PATH,
          voiceStylePath: voicePath,
          preloadCount: 4,
          speed: speechRate,
          totalSteps: 5
        });

        // Connect sentence state changes to the store
        service.onSentenceStateChange((sentenceId, state) => {
          if (mounted) {
            setSentenceState(sentenceId, state);
          }
        });

        await service.initialize((stage, progress, message) => {
          if (!mounted) return;
          setInitProgress(progress);
          setInitMessage(message);
        });

        if (!mounted) {
          service.dispose();
          return;
        }

        serviceRef.current = service;
        setTTSReady(true);
        setTTSBackend(service.getBackend());

        // Set up continuous preloading - extend queue as items complete
        service.setOnPreloadComplete((sentenceId, cacheSize) => {
          const chapter = getCurrentChapter();
          if (!chapter) return;

          // Only extend if still playing
          const state = useReaderStore.getState();
          if (!state.isPlaying) return;

          // Extend queue starting from current position + what we have cached
          const startFrom = state.currentSentenceIndex + cacheSize + 1;
          if (startFrom < chapter.sentences.length) {
            service.extendPreloadQueue(chapter.sentences, startFrom);
          }
        });

        // Register stable event handler
        service.addEventListener((event) => {
          handlePlaybackEventRef.current(event);
        });
      } catch (error) {
        console.error('Failed to initialize audio service:', error);
        if (mounted) {
          setInitMessage('Failed to initialize TTS');
        }
      } finally {
        if (mounted) {
          setTTSLoading(false);
        }
      }
    };

    init();

    return () => {
      mounted = false;
      cancelSession();
      if (serviceRef.current) {
        serviceRef.current.dispose();
        serviceRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update event handler ref when dependencies change (avoids stale closure)
  useEffect(() => {
    handlePlaybackEventRef.current = (event: PlaybackEvent) => {
      const service = serviceRef.current;

      switch (event.type) {
        case 'wordChange':
          if (event.sentenceId && event.wordIndex !== undefined) {
            setHighlight(event.sentenceId, event.wordIndex);
          }
          break;

        case 'sentenceEnd':
          // Mark as played
          if (event.sentenceId && service) {
            service.markPlayed(event.sentenceId);
          }

          // Reset pause state for new sentence
          isPausedRef.current = false;

          // Automatically advance to next sentence
          const hasNext = nextSentence();
          if (!hasNext) {
            // End of book/chapter
            setIsPlaying(false);
            sessionRef.current.sentenceId = null;
          }
          break;

        case 'error':
          console.error('Playback error:', event.error);
          setIsPlaying(false);
          break;
      }
    };
  }, [setHighlight, nextSentence, setIsPlaying]);

  // Handle play state changes - passive effect that handles pause/resume and auto-advance
  // Manual skips are handled by skipToSentence directly to avoid race conditions
  useEffect(() => {
    const service = serviceRef.current;
    if (!service || !service.isReady()) return;

    const chapter = getCurrentChapter();
    if (!chapter) return;

    const sentence = chapter.sentences[currentSentenceIndex];
    if (!sentence) return;

    if (isPlaying) {
      // Check for resume FIRST - isPausedRef takes priority over session check
      // because pause doesn't clear the session ID
      if (isPausedRef.current) {
        // Resume from pause (same sentence, just paused)
        service.resume();
        isPausedRef.current = false;
      } else if (sessionRef.current.sentenceId === sentence.id) {
        // Already playing/preparing this sentence (skipToSentence already started it)
        // This prevents duplicate playback when clicking a sentence triggers both
        // skipToSentence AND this effect via state changes
        service.preloadSentences(chapter.sentences, currentSentenceIndex + 1);
        return;
      } else {
        // New sentence (auto-advance from sentenceEnd or initial play) - start fresh
        const session = newSession(sentence.id);

        service.playSentence(sentence, session.abortController.signal).catch(error => {
          if (error.name !== 'AbortError') {
            console.error('Failed to play sentence:', error);
            setIsPlaying(false);
          }
        });
      }

      // Preload upcoming sentences
      service.preloadSentences(chapter.sentences, currentSentenceIndex + 1);
    } else {
      // Pause if currently playing
      if (service.isPlaying()) {
        service.pause();
        isPausedRef.current = true;
      }
    }
  }, [isPlaying, currentSentenceIndex, currentChapterIndex, newSession, getCurrentChapter, setIsPlaying]);

  // Handle volume changes
  useEffect(() => {
    if (serviceRef.current) {
      serviceRef.current.setVolume(volume);
    }
  }, [volume]);

  // Handle speech rate changes (TTS generation speed - clears cache)
  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;

    // Cancel current operations when speech rate changes
    cancelSession();
    service.setSpeechRate(speechRate);

    // Clear sentence states since audio needs regeneration
    clearSentenceStates();
  }, [speechRate, cancelSession, clearSentenceStates]);

  // Handle audio playback rate changes (just speeds up playback, no cache clear)
  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;

    service.setAudioPlaybackRate(audioPlaybackRate);
  }, [audioPlaybackRate]);

  // Handle voice changes
  useEffect(() => {
    const service = serviceRef.current;
    if (!service || !service.isReady()) return;

    // Cancel current operations when voice changes
    cancelSession();

    const voicePath = VOICE_PATHS[currentVoice] || VOICE_PATHS['M1'];
    service.setVoiceStyle(voicePath).catch(error => {
      console.error('Failed to change voice:', error);
    });

    // Clear sentence states since audio needs regeneration
    clearSentenceStates();
  }, [currentVoice, cancelSession, clearSentenceStates]);

  // Handle chapter changes - cancel operations and reset state
  useEffect(() => {
    const service = serviceRef.current;

    // Cancel existing operations
    cancelSession();

    // Clear highlights and states
    setHighlight(null, null);
    clearSentenceStates();
    isPausedRef.current = false;

    if (!service || !currentBook) return;

    const chapter = currentBook.chapters[currentChapterIndex];
    if (chapter) {
      // Preload first few sentences of new chapter
      service.preloadSentences(chapter.sentences, 0);
    }
  }, [currentChapterIndex, currentBook, setHighlight, clearSentenceStates, cancelSession]);

  /**
   * Play/pause toggle - OPTIMISTIC: updates state immediately
   * Background work happens async, cancelling any existing operations
   */
  const handlePlayPause = useCallback(() => {
    // IMMEDIATE state update (optimistic UI)
    setIsPlaying(!isPlaying);
  }, [isPlaying, setIsPlaying]);

  /**
   * Cancel all operations and stop playback
   */
  const cancelAllOperations = useCallback(() => {
    cancelSession();
    serviceRef.current?.cancelAllOperations();
    setIsPlaying(false);
    isPausedRef.current = false;
  }, [cancelSession, setIsPlaying]);

  /**
   * Change chapter - cancels operations and resets state
   */
  const handleChapterChange = useCallback((chapterIndex: number) => {
    // Cancel all pending operations FIRST
    cancelAllOperations();

    // Then update chapter (store will clear sentence states)
    useReaderStore.getState().setChapter(chapterIndex);
  }, [cancelAllOperations]);

  // Play a specific sentence - updates state, play effect handles actual playback
  const playSentence = useCallback((sentence: Sentence) => {
    const service = serviceRef.current;
    if (!service || !service.isReady()) return;

    // Find sentence index and update store state
    const chapter = getCurrentChapter();
    if (chapter) {
      const index = chapter.sentences.findIndex(s => s.id === sentence.id);
      if (index >= 0) {
        useReaderStore.getState().setSentence(index);
      }
    }

    // Update highlight and ensure playing
    setHighlight(sentence.id, null);
    isPausedRef.current = false;
    setIsPlaying(true);

    // Play effect will handle actual playback
  }, [getCurrentChapter, setHighlight, setIsPlaying]);

  // Skip to sentence - SINGLE entry point for sentence changes
  // Stops current audio, updates state, and starts new playback directly
  const skipToSentence = useCallback((index: number) => {
    const chapter = getCurrentChapter();
    if (!chapter || index < 0 || index >= chapter.sentences.length) return;

    const sentence = chapter.sentences[index];
    const service = serviceRef.current;

    // STOP current playback first to ensure clean state
    if (service && service.isPlaying()) {
      service.stop();
    }

    // Cancel existing session and create new one BEFORE state updates
    const session = newSession(sentence.id);
    isPausedRef.current = false;

    // Update state atomically
    setHighlight(sentence.id, null);
    useReaderStore.getState().setSentence(index);

    // Start playback if service is ready
    if (service && service.isReady()) {
      service.playSentence(sentence, session.abortController.signal).catch(error => {
        if (error.name !== 'AbortError') {
          console.error('Failed to play sentence:', error);
          setIsPlaying(false);
        }
      });

      // Ensure playing state
      if (!useReaderStore.getState().isPlaying) {
        setIsPlaying(true);
      }

      // Preload upcoming sentences
      service.preloadSentences(chapter.sentences, index + 1);
    } else {
      // No service ready, just ensure playing state for when it loads
      setIsPlaying(true);
    }
  }, [getCurrentChapter, setHighlight, setIsPlaying, newSession]);

  return {
    initProgress,
    initMessage,
    isServiceReady: serviceRef.current?.isReady() ?? false,
    handlePlayPause,
    handleChapterChange,
    cancelAllOperations,
    playSentence,
    skipToSentence
  };
}
