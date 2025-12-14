'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useNavigationStore } from '@/store/navigationStore';
import { usePlaybackStore } from '@/store/playbackStore';
import { useTTSStore } from '@/store/ttsStore';
import { useSentenceStateStore } from '@/store/sentenceStateStore';
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

export function useAudioPlayback() {
  const serviceRef = useRef<AudioSyncService | null>(null);
  const [initProgress, setInitProgress] = useState(0);
  const [initMessage, setInitMessage] = useState('');

  // Ref for stable event handler (avoids stale closures)
  const handlePlaybackEventRef = useRef<(event: PlaybackEvent) => void>(() => {});

  // Navigation store
  const currentBook = useNavigationStore(state => state.currentBook);
  const currentChapterIndex = useNavigationStore(state => state.currentChapterIndex);
  const currentSentenceIndex = useNavigationStore(state => state.currentSentenceIndex);
  const getCurrentChapter = useNavigationStore(state => state.getCurrentChapter);
  const setSentenceIndex = useNavigationStore(state => state.setSentenceIndex);
  const setChapter = useNavigationStore(state => state.setChapter);
  const nextSentence = useNavigationStore(state => state.nextSentence);

  // Playback store (with session management)
  const isPlaying = usePlaybackStore(state => state.isPlaying);
  const volume = usePlaybackStore(state => state.volume);
  const speechRate = usePlaybackStore(state => state.speechRate);
  const audioPlaybackRate = usePlaybackStore(state => state.audioPlaybackRate);
  const session = usePlaybackStore(state => state.session);
  const setIsPlaying = usePlaybackStore(state => state.setIsPlaying);
  const startSession = usePlaybackStore(state => state.startSession);
  const endSession = usePlaybackStore(state => state.endSession);
  const setPaused = usePlaybackStore(state => state.setPaused);
  const updateSessionSentence = usePlaybackStore(state => state.updateSessionSentence);

  // TTS store
  const currentVoice = useTTSStore(state => state.currentVoice);
  const setTTSReady = useTTSStore(state => state.setTTSReady);
  const setTTSLoading = useTTSStore(state => state.setTTSLoading);
  const setTTSBackend = useTTSStore(state => state.setTTSBackend);

  // Sentence state store
  const setSentenceState = useSentenceStateStore(state => state.setSentenceState);
  const clearSentenceStates = useSentenceStateStore(state => state.clearSentenceStates);
  const setHighlight = useSentenceStateStore(state => state.setHighlight);
  const clearHighlight = useSentenceStateStore(state => state.clearHighlight);

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

        // Start preloading Parakeet ASR model in background (non-blocking)
        // This ensures ASR is ready when we have enough buffer for timestamp refinement
        service.preloadParakeet();

        // Note: preloadFullChapter() queues the entire chapter at once,
        // so continuous extension via onItemComplete is no longer needed.
        // Preloading continues even when paused.

        // Register stable event handler
        service.addEventListener((event) => {
          handlePlaybackEventRef.current(event);
        });

        // Register ASR completion callback for live timestamp updates
        service.onASRComplete((sentenceId, timestamps) => {
          console.log(`[ASR] Timestamps upgraded for ${sentenceId}:`, timestamps.length, 'words');
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
      endSession();
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
            setHighlight(event.sentenceId, event.wordIndex, event.timestampSource);
          }
          break;

        case 'sentenceEnd':
          // Mark as played
          if (event.sentenceId && service) {
            service.markPlayed(event.sentenceId);
          }

          // Reset pause state for new sentence
          setPaused(false);

          // Automatically advance to next sentence
          const hasNext = nextSentence();
          if (!hasNext) {
            // End of book/chapter
            setIsPlaying(false);
            updateSessionSentence('');
          }
          break;

        case 'error':
          console.error('Playback error:', event.error);
          setIsPlaying(false);
          break;
      }
    };
  }, [setHighlight, nextSentence, setIsPlaying, setPaused, updateSessionSentence]);

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
      // Check for resume FIRST - isPaused takes priority over session check
      // because pause doesn't clear the session ID
      if (session.isPaused) {
        // Resume from pause (same sentence, just paused)
        service.resume();
        setPaused(false);
      } else if (session.sentenceId === sentence.id) {
        // Already playing/preparing this sentence (skipToSentence already started it)
        // This prevents duplicate playback when clicking a sentence triggers both
        // skipToSentence AND this effect via state changes
        service.preloadFullChapter(chapter.sentences, currentSentenceIndex + 1);
        return;
      } else {
        // New sentence (auto-advance from sentenceEnd or initial play) - start fresh
        const abortController = startSession(sentence.id, currentChapterIndex);

        // Update ASR tracking position for progressive timestamp refinement
        service.setCurrentPlayingIndex(currentSentenceIndex, chapter.sentences);

        service.playSentence(sentence, abortController.signal).catch(error => {
          if (error.name !== 'AbortError') {
            console.error('Failed to play sentence:', error);
            setIsPlaying(false);
          }
        });
      }

      // Preload entire chapter from current position
      service.preloadFullChapter(chapter.sentences, currentSentenceIndex + 1);
    } else {
      // Pause if currently playing
      if (service.isPlaying()) {
        service.pause();
        setPaused(true);
      }
    }
  }, [isPlaying, currentSentenceIndex, currentChapterIndex, session.sentenceId, session.isPaused, startSession, getCurrentChapter, setIsPlaying, setPaused]);

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
    endSession();
    service.setSpeechRate(speechRate);

    // Clear sentence states since audio needs regeneration
    clearSentenceStates();
  }, [speechRate, endSession, clearSentenceStates]);

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
    endSession();

    const voicePath = VOICE_PATHS[currentVoice] || VOICE_PATHS['M1'];
    service.setVoiceStyle(voicePath).catch(error => {
      console.error('Failed to change voice:', error);
    });

    // Clear sentence states since audio needs regeneration
    clearSentenceStates();
  }, [currentVoice, endSession, clearSentenceStates]);

  // Handle chapter changes - cancel operations and reset state
  useEffect(() => {
    const service = serviceRef.current;

    // Cancel existing operations
    endSession();

    // Clear highlights and states
    clearHighlight();
    clearSentenceStates();

    if (!service || !currentBook) return;

    const chapter = currentBook.chapters[currentChapterIndex];
    if (chapter) {
      // Preload entire chapter
      service.preloadFullChapter(chapter.sentences, 0);
    }
  }, [currentChapterIndex, currentBook, clearHighlight, clearSentenceStates, endSession]);

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
    endSession();
    serviceRef.current?.cancelAllOperations();
    setIsPlaying(false);
  }, [endSession, setIsPlaying]);

  /**
   * Change chapter - cancels operations and resets state
   */
  const handleChapterChange = useCallback((chapterIndex: number) => {
    // Cancel all pending operations FIRST
    cancelAllOperations();

    // Then update chapter (store will clear sentence states)
    setChapter(chapterIndex);
  }, [cancelAllOperations, setChapter]);

  // Play a specific sentence - updates state, play effect handles actual playback
  const playSentence = useCallback((sentence: Sentence) => {
    const service = serviceRef.current;
    if (!service || !service.isReady()) return;

    // Find sentence index and update store state
    const chapter = getCurrentChapter();
    if (chapter) {
      const index = chapter.sentences.findIndex(s => s.id === sentence.id);
      if (index >= 0) {
        setSentenceIndex(index);
      }
    }

    // Update highlight and ensure playing
    setHighlight(sentence.id, null);
    setPaused(false);
    setIsPlaying(true);

    // Play effect will handle actual playback
  }, [getCurrentChapter, setHighlight, setIsPlaying, setSentenceIndex, setPaused]);

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
    const abortController = startSession(sentence.id, currentChapterIndex);

    // Update state atomically
    setHighlight(sentence.id, null);
    setSentenceIndex(index);

    // Start playback if service is ready
    if (service && service.isReady()) {
      // Update ASR tracking position for progressive timestamp refinement
      service.setCurrentPlayingIndex(index, chapter.sentences);

      service.playSentence(sentence, abortController.signal).catch(error => {
        if (error.name !== 'AbortError') {
          console.error('Failed to play sentence:', error);
          setIsPlaying(false);
        }
      });

      // Ensure playing state
      if (!usePlaybackStore.getState().isPlaying) {
        setIsPlaying(true);
      }

      // Preload entire chapter from current position
      service.preloadFullChapter(chapter.sentences, index + 1);
    } else {
      // No service ready, just ensure playing state for when it loads
      setIsPlaying(true);
    }
  }, [getCurrentChapter, setHighlight, setIsPlaying, setSentenceIndex, startSession, currentChapterIndex]);

  return {
    initProgress,
    initMessage,
    isServiceReady: serviceRef.current?.isReady() ?? false,
    handlePlayPause,
    handleChapterChange,
    cancelAllOperations,
    playSentence,
    skipToSentence,
    service: serviceRef.current
  };
}
