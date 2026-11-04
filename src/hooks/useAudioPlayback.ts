'use client';

import { useEffect, useRef, useCallback, useState, useTransition } from 'react';
import { useNavigationStore } from '@/store/navigationStore';
import { usePlaybackStore } from '@/store/playbackStore';
import { useTTSStore } from '@/store/ttsStore';
import { useSentenceStateStore, setHighlight, clearHighlight, setAudioPosition, clearAudioPosition, addToPlayedTime } from '@/store/sentenceStateStore';
import { useSleepTimerStore } from '@/store/sleepTimerStore';
import {
  AudioSyncService,
  initializeAudioSyncService,
  PlaybackEvent
} from '@/lib/audio';
import { Sentence } from '@/lib/epub';
import { getInflectVoice } from '@/lib/tts/inflectVoices';

const TTS_MODEL_PATH = '/models/inflect';

export function useAudioPlayback() {
  const serviceRef = useRef<AudioSyncService | null>(null);
  const [initProgress, setInitProgress] = useState(0);
  const [initMessage, setInitMessage] = useState('');

  // Fix 6: useTransition for non-urgent updates
  const [, startTransition] = useTransition();

  // Ref for stable event handler (avoids stale closures)
  const handlePlaybackEventRef = useRef<(event: PlaybackEvent) => void>(() => {});

  // Navigation store - FIX P1-2: Use direct selector instead of getter to prevent stale closures
  const currentBook = useNavigationStore(state => state.currentBook);
  const currentChapterIndex = useNavigationStore(state => state.currentChapterIndex);
  const currentSentenceIndex = useNavigationStore(state => state.currentSentenceIndex);
  const currentChapter = useNavigationStore(state =>
    state.currentBook?.chapters[state.currentChapterIndex] ?? null
  );
  const setSentenceIndex = useNavigationStore(state => state.setSentenceIndex);
  const setChapter = useNavigationStore(state => state.setChapter);
  const nextSentence = useNavigationStore(state => state.nextSentence);

  // Playback store (with session management)
  const isPlaying = usePlaybackStore(state => state.isPlaying);
  const volume = usePlaybackStore(state => state.volume);
  const speechRate = usePlaybackStore(state => state.speechRate);
  const audioPlaybackRate = usePlaybackStore(state => state.audioPlaybackRate);
  const enableASR = usePlaybackStore(state => state.enableASR);
  const enableLazyVoiceLoading = usePlaybackStore(state => state.enableLazyVoiceLoading);
  // rerender-derived-state: subscribe to primitive boolean instead of session object
  const isPaused = usePlaybackStore(state => state.session.isPaused);
  const setIsPlaying = usePlaybackStore(state => state.setIsPlaying);
  const startSession = usePlaybackStore(state => state.startSession);
  const endSession = usePlaybackStore(state => state.endSession);
  const setPaused = usePlaybackStore(state => state.setPaused);

  // TTS store
  const currentVoice = useTTSStore(state => state.currentVoice);
  const setTTSReady = useTTSStore(state => state.setTTSReady);
  const setTTSLoading = useTTSStore(state => state.setTTSLoading);
  const setTTSBackend = useTTSStore(state => state.setTTSBackend);

  // Sentence state store
  const setSentenceState = useSentenceStateStore(state => state.setSentenceState);
  const clearSentenceStates = useSentenceStateStore(state => state.clearSentenceStates);
  const markASRComplete = useSentenceStateStore(state => state.markASRComplete);
  const clearASRCompleted = useSentenceStateStore(state => state.clearASRCompleted);

  // Sentence the current play session owns: set when playback of a sentence is
  // started (play effect / skipToSentence) or adopted from a player hand-off.
  // null means "nothing resumable" (stopped, ended, errored, chapter/voice/rate
  // change) — the next Play then starts the current sentence fresh instead of
  // resuming whatever audio element happens to be loaded.
  const sessionSentenceIdRef = useRef<string | null>(null);

  // Initialize audio service
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (serviceRef.current) return;

      setTTSLoading(true);
      setInitProgress(0);
      setInitMessage('Initializing...');

      try {
        const voicePath = getInflectVoice(currentVoice).modelPath;
        // Capture the flag value on mount (won't change during initialization)
        const useLazyLoading = usePlaybackStore.getState().enableLazyVoiceLoading;

        const service = initializeAudioSyncService({
          ttsModelPath: TTS_MODEL_PATH,
          voiceStylePath: voicePath,
          preloadCount: 4,
          speed: speechRate,
          // Inflect runs one duration pass and one decode pass (no diffusion loop).
          totalSteps: 2,
          enableLazyVoiceLoading: useLazyLoading
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

        // Warm up AudioContext early (must be in response to user gesture)
        // Opening a book counts as user interaction
        service.initAudioContext().catch(error => {
          console.warn('Failed to initialize AudioContext:', error);
        });

        // Start preloading Parakeet ASR model in background (non-blocking)
        // Only if ASR is enabled - saves ~50MB download when disabled
        if (usePlaybackStore.getState().enableASR) {
          service.preloadParakeet();
        }

        // Note: preloadFullChapter() queues the entire chapter at once,
        // so continuous extension via onItemComplete is no longer needed.
        // Preloading continues even when paused.

        // Register stable event handler
        // Note: The cleanup is handled in service.dispose() which clears all event handlers
        service.addEventListener((event) => {
          handlePlaybackEventRef.current(event);
        });

        // Register ASR completion callback for live timestamp updates (only if enabled)
        if (usePlaybackStore.getState().enableASR) {
          service.onASRComplete((sentenceId, timestamps) => {
            console.log(`[ASR] Timestamps upgraded for ${sentenceId}:`, timestamps.length, 'words');
            if (mounted) {
              // Fix 9: Debounce ASR completion callbacks - defer to idle time
              if ('requestIdleCallback' in window) {
                requestIdleCallback(() => {
                  markASRComplete(sentenceId);
                }, { timeout: 1000 });
              } else {
                setTimeout(() => markASRComplete(sentenceId), 100);
              }
            }
          });
        }
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
          // Update audio position for real-time timestamp display
          if (event.currentTime !== undefined) {
            setAudioPosition(event.currentTime);
          }
          break;

        case 'sentenceStart': {
          const sentenceId = event.sentenceId;
          if (!sentenceId || !service) break;

          if (service.isHandoffStart(sentenceId)) {
            // Near-end hand-off: the player has ALREADY started the next sentence
            // (its audio is playing). Adopt it as this session's sentence BEFORE
            // moving the index, so the play effect sees "already playing this
            // sentence" and does not restart it. The finished sentence still gets
            // its own sentenceEnd (bookkeeping only — see below).
            // Use getState() inside event handler to get fresh chapter data
            const navState = useNavigationStore.getState();
            const chapter = navState.currentBook?.chapters[navState.currentChapterIndex];
            const index = chapter ? chapter.sentences.findIndex(s => s.id === sentenceId) : -1;
            if (chapter && index !== -1) {
              sessionSentenceIdRef.current = sentenceId;
              // Keep cache-eviction protection / ASR / next look-ahead in step
              service.setCurrentPlayingIndex(index, chapter.sentences);
              service.markPlaying(sentenceId);
              setHighlight(sentenceId, null);

              setSentenceIndex(index);
            }
            break;
          }

          // A start for a sentence this session isn't playing is a superseded
          // start; don't let it move highlight or navigation.
          if (sentenceId !== sessionSentenceIdRef.current) break;

          // FIX Bug 2: Initialize highlight for new sentence (clears stale highlight)
          setHighlight(sentenceId, null);
          break;
        }

        case 'sentenceEnd': {
          // Add completed sentence duration to cumulative time (for accurate timestamp display)
          if (event.duration !== undefined && event.duration > 0) {
            addToPlayedTime(event.duration);
          }

          const sentenceId = event.sentenceId;

          // Defer ALL state updates to microtask to avoid race conditions with play effect
          queueMicrotask(() => {
            // Mark sentence as played (visual feedback)
            if (sentenceId && service) {
              startTransition(() => {
                service.markPlayed(sentenceId);
              });
            }

            // PAUSE FORCE-RESUME GUARD: do NOT clear pause state here. This
            // microtask fires on every sentenceEnd; clearing isPaused based on a
            // momentary isPlaying===true read races with a user pause that lands at
            // the sentence boundary, dropping the pause intent. Pause clearing is
            // owned exclusively by the explicit resume branch in the play-effect and
            // by playSentence/skipToSentence. Normal auto-advance never paused, so
            // there is nothing to clear here.

            // Only the end of the sentence this session is playing drives
            // advancement. Any other sentenceEnd is the tail of a near-end hand-off
            // (the player already moved on and the session adopted the next
            // sentence) or stale — bookkeeping above only. Checked here, at
            // microtask time, because a short sentence's onended emits
            // sentenceEnd just before the hand-off's sentenceStart.
            if (!sentenceId || sentenceId !== sessionSentenceIdRef.current) return;

            // Check store's isPlaying to respect user pause intent
            // If user clicked pause, isPlaying will be false and we shouldn't advance
            if (!usePlaybackStore.getState().isPlaying) {
              // The sentence finished while pause/stop was pending, so there is
              // nothing left to resume: the next Play starts it fresh.
              sessionSentenceIdRef.current = null;
              return;
            }

            // Sleep timer "end of chapter": stop after the chapter's last sentence.
            // (nextSentence() crosses chapters, so its return value only signals
            // end of BOOK and can't be used for this.)
            const sleepTimer = useSleepTimerStore.getState();
            if (sleepTimer.isActive && sleepTimer.selectedPreset === 'chapter_end') {
              const navState = useNavigationStore.getState();
              const chapter = navState.currentBook?.chapters[navState.currentChapterIndex];
              const lastSentence = chapter?.sentences[chapter.sentences.length - 1];
              if (lastSentence?.id === sentenceId) {
                sleepTimer.stopTimer();
                sessionSentenceIdRef.current = null;
                setIsPlaying(false);
                return;
              }
            }

            const hasNext = nextSentence();
            if (!hasNext) {
              // End of book
              sessionSentenceIdRef.current = null;
              setIsPlaying(false);
            }
            // If hasNext, the play effect will be triggered by currentSentenceIndex change
          });
          break;
        }

        case 'scheduleMore':
          // Request to schedule more look-ahead sentences
          if (service) {
            service.scheduleMoreSentences();
          }
          break;

        case 'stop':
          // Playback stopped (end of chapter or explicit stop). Stopped is not
          // paused: nothing is resumable, the next Play starts fresh.
          sessionSentenceIdRef.current = null;
          setIsPlaying(false);
          clearAudioPosition();
          break;

        case 'error':
          console.error('Playback error:', event.error);
          sessionSentenceIdRef.current = null;
          setIsPlaying(false);
          break;
      }
    };
  }, [nextSentence, setIsPlaying, setPaused, setSentenceIndex]);

  // Handle chapter changes - cancel operations and reset state.
  //
  // ORDER MATTERS: this effect is declared BEFORE the play effect so that, in a
  // commit where the chapter changed, it ends the OLD session first and the play
  // effect then starts the new chapter's session. (Declared after, an auto-advance
  // across a chapter boundary would have its brand-new session aborted here,
  // stalling playback with isPlaying=true.) A manual chapter change still stops
  // playback deliberately via handleChapterChange → cancelAllOperations.
  useEffect(() => {
    const service = serviceRef.current;

    // Cancel existing operations
    endSession();
    sessionSentenceIdRef.current = null;

    // Clear highlights and states
    clearHighlight();
    clearAudioPosition();
    clearSentenceStates();
    clearASRCompleted();

    if (!service || !currentBook) return;

    const chapter = currentBook.chapters[currentChapterIndex];
    if (chapter) {
      // Preload entire chapter
      service.preloadFullChapter(chapter.sentences, 0);
    }
  }, [currentChapterIndex, currentBook, clearSentenceStates, clearASRCompleted, endSession]);

  // Handle play state changes - passive effect that handles pause/resume and auto-advance
  // Manual skips are handled by skipToSentence directly to avoid race conditions
  useEffect(() => {
    const service = serviceRef.current;
    if (!service || !service.isReady()) return;

    if (!currentChapter) return;

    const sentence = currentChapter.sentences[currentSentenceIndex];
    if (!sentence) return;

    if (isPlaying) {
      // PAUSE FORCE-RESUME GUARD: index/chapter changes while paused (user ↑/↓,
      // media-session next/prev, a hand-off racing the pause) run with
      // isPlaying=false and land in the pause branch below — they can never
      // resume audio. isPlaying && isPaused is only reachable through an explicit
      // play request (play button, Space, media session play, visibility restore,
      // autoplay), since every handled play run clears isPaused (resume →
      // setPaused(false), fresh start → startSession()). So here we only decide
      // HOW to honour that request:
      //  - resume, if the paused sentence IS the current one and the player still
      //    holds resumable audio for it;
      //  - otherwise start the current sentence fresh (the user navigated while
      //    paused, or playback was stopped / ended / errored, which clears
      //    sessionSentenceIdRef).
      if (isPaused) {
        if (sessionSentenceIdRef.current === sentence.id && service.resume()) {
          setPaused(false);
          service.preloadFullChapter(currentChapter.sentences, currentSentenceIndex + 1);
          return;
        }
        // fall through to a fresh start
      } else if (sessionSentenceIdRef.current === sentence.id) {
        // Fix 10: Use ref instead of state for comparison
        // Already playing/preparing this sentence (skipToSentence started it, or
        // the player handed off to it). Don't restart it.
        service.preloadFullChapter(currentChapter.sentences, currentSentenceIndex + 1);
        return;
      }

      // New sentence (auto-advance, navigation, initial play, play after stop) -
      // start fresh. startSession() aborts the previous session and clears isPaused.
      const abortController = startSession();

      // Sync ref IMMEDIATELY to prevent stale comparison on next effect run
      sessionSentenceIdRef.current = sentence.id;

      // Update playback position for cache eviction protection and ASR
      service.setCurrentPlayingIndex(currentSentenceIndex, currentChapter.sentences);

      // Always use playSentenceStreaming for sentence-by-sentence playback
      // It handles both cached (instant via HTMLAudioElement) and uncached (streaming worklet)
      service.playSentenceStreaming(sentence, abortController.signal, audioPlaybackRate).catch(error => {
        if (error.name !== 'AbortError') {
          console.error('Failed to play sentence:', error);
          setIsPlaying(false);
        }
      });

      // Preload entire chapter from current position
      service.preloadFullChapter(currentChapter.sentences, currentSentenceIndex + 1);
    } else {
      // Unconditionally pause — removes the race where isPlaying() is momentarily
      // false during a sentence transition, causing the pause intent to be dropped.
      // AudioPlayer.pause() is already idempotent (guards with !this.isPlaying internally).
      service.pause();
      setPaused(true);
    }
  }, [isPlaying, currentSentenceIndex, currentChapterIndex, currentChapter, isPaused, audioPlaybackRate, startSession, setIsPlaying, setPaused]);

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
    // Cached audio is discarded, so the current sentence is no longer resumable
    sessionSentenceIdRef.current = null;
    service.setSpeechRate(speechRate);

    // Clear sentence states since audio needs regeneration
    clearSentenceStates();
    clearASRCompleted();
  }, [speechRate, endSession, clearSentenceStates, clearASRCompleted]);

  // Handle audio playback rate changes (just speeds up playback, no cache clear)
  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;

    service.setAudioPlaybackRate(audioPlaybackRate);
  }, [audioPlaybackRate]);

  // Handle ASR setting changes - sync to service
  useEffect(() => {
    const service = serviceRef.current;
    if (!service) return;

    service.setEnableASR(enableASR);

    // Clear ASR state when disabled
    if (!enableASR) {
      clearASRCompleted();
    }
  }, [enableASR, clearASRCompleted]);

  // Handle voice changes
  useEffect(() => {
    const service = serviceRef.current;
    if (!service || !service.isReady()) return;

    // Cancel current operations when voice changes
    endSession();
    sessionSentenceIdRef.current = null;

    const voicePath = getInflectVoice(currentVoice).modelPath;
    service.setVoiceStyle(voicePath).catch(error => {
      console.error('Failed to change voice:', error);
    });

    // Clear sentence states since audio needs regeneration
    clearSentenceStates();
    clearASRCompleted();
  }, [currentVoice, endSession, clearSentenceStates, clearASRCompleted]);


  /**
   * Play/pause toggle - OPTIMISTIC: updates state immediately
   * Background work happens async, cancelling any existing operations
   */
  const handlePlayPause = useCallback(() => {
    const { isPlaying, setIsPlaying } = usePlaybackStore.getState();
    setIsPlaying(!isPlaying);
  }, []);

  /**
   * Cancel all operations and stop playback
   */
  const cancelAllOperations = useCallback(() => {
    endSession();
    sessionSentenceIdRef.current = null;
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
    // Use getState() to get fresh chapter data
    const navState = useNavigationStore.getState();
    const chapter = navState.currentBook?.chapters[navState.currentChapterIndex];
    if (chapter) {
      const index = chapter.sentences.findIndex(s => s.id === sentence.id);
      if (index >= 0) {
        setSentenceIndex(index);
      }
    }

    // Update highlight and ensure playing. Clear the session sentence so the play
    // effect starts this sentence fresh even if it is the one currently paused
    // (with isPaused=false and a matching ref it would otherwise do nothing).
    sessionSentenceIdRef.current = null;
    setHighlight(sentence.id, null);
    setPaused(false);
    setIsPlaying(true);


    // Play effect will handle actual playback
  }, [setIsPlaying, setSentenceIndex, setPaused]);

  // Skip to sentence - SINGLE entry point for sentence changes
  // Stops current audio, updates state, and starts new playback directly
  const skipToSentence = useCallback((index: number) => {
    // Use getState() to get fresh chapter data
    const navState = useNavigationStore.getState();
    const chapter = navState.currentBook?.chapters[navState.currentChapterIndex];
    if (!chapter || index < 0 || index >= chapter.sentences.length) return;

    const sentence = chapter.sentences[index];
    const service = serviceRef.current;

    // STOP current playback first to ensure clean state (handles both modes)
    if (service && service.isPlaying()) {
      service.stop();
    }

    // Cancel existing session and create new one BEFORE state updates
    const abortController = startSession();

    // Sync ref IMMEDIATELY to prevent stale comparison in play effect
    sessionSentenceIdRef.current = sentence.id;

    // Update state atomically
    setHighlight(sentence.id, null);
    setSentenceIndex(index);

    // Start playback if service is ready
    if (service && service.isReady()) {
      // Update playback position for cache eviction protection and ASR
      service.setCurrentPlayingIndex(index, chapter.sentences);

      // Always use playSentenceStreaming - handles both cached and uncached
      // without setting gapless mode, allowing proper sentenceEnd advancement
      service.playSentenceStreaming(sentence, abortController.signal, audioPlaybackRate).catch(error => {
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
  }, [setIsPlaying, setSentenceIndex, startSession, audioPlaybackRate]);

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
