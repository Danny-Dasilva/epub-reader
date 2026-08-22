import type { AudioOutput, AudioStatusEvent } from '@/lib/audio/AudioOutput';
import { PlaybackCoordinator, type PlaybackState } from '@/lib/playback/PlaybackCoordinator';
import type { SpeechSynthesizer } from '@/lib/tts/InflectSynthesizer';
import type { SynthesizedAudio } from '@/types/reader';
import { TEST_BOOK } from '@/testing/fixtures';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeAudioOutput implements AudioOutput {
  listener: ((status: AudioStatusEvent) => void) | null = null;
  replacements: string[] = [];
  playCount = 0;
  pauseCount = 0;
  released = false;

  replace(uri: string) { this.replacements.push(uri); }
  play() { this.playCount += 1; }
  pause() { this.pauseCount += 1; }
  seek() { return Promise.resolve(); }
  setRate() {}
  setVolume() {}
  setStatusListener(listener: (status: AudioStatusEvent) => void) { this.listener = listener; }
  release() { this.released = true; }
  emit(status: Partial<AudioStatusEvent>) {
    this.listener?.({ position: 0, duration: 3, playing: true, didJustFinish: false, ...status });
  }
}

class FakeSynthesizer implements SpeechSynthesizer {
  calls: string[] = [];
  released = false;

  async synthesize(text: string): Promise<SynthesizedAudio> {
    this.calls.push(text);
    return {
      uri: `file://${this.calls.length}.wav`,
      duration: 3,
      wordTimings: [
        { word: 'first', start: 0, end: 1 },
        { word: 'second', start: 1, end: 2 },
        { word: 'third', start: 2, end: 3 },
      ],
    };
  }
  release() { this.released = true; }
}

function setup() {
  const audio = new FakeAudioOutput();
  const synth = new FakeSynthesizer();
  const states: PlaybackState[] = [];
  const coordinator = new PlaybackCoordinator(synth, audio, (state) => states.push(state));
  coordinator.setBook(TEST_BOOK);
  return { audio, synth, states, coordinator };
}

describe('PlaybackCoordinator', () => {
  it('plays, pauses, and resumes the same synthesized sentence', async () => {
    const { audio, synth, coordinator } = setup();
    await coordinator.play();
    expect(coordinator.snapshot.isPlaying).toBe(true);
    expect(audio.playCount).toBe(1);
    expect(synth.calls).toEqual(['One two three.']);

    coordinator.pause();
    expect(coordinator.snapshot.isPlaying).toBe(false);
    expect(audio.pauseCount).toBeGreaterThan(0);

    await coordinator.play();
    expect(audio.playCount).toBe(2);
    expect(synth.calls).toHaveLength(1);
  });

  it('updates word highlighting from native playback time', async () => {
    const { audio, coordinator } = setup();
    await coordinator.play();
    audio.emit({ position: 1.25 });
    expect(coordinator.snapshot.activeSentenceId).toBe('sentence-0');
    expect(coordinator.snapshot.currentWordIndex).toBe(1);
  });

  it('does not advance from a stale finish event after the user pauses', async () => {
    const { audio, coordinator } = setup();
    await coordinator.play();
    coordinator.pause();
    audio.emit({ position: 3, didJustFinish: true, playing: false });
    await tick();
    expect(coordinator.snapshot.sentenceIndex).toBe(0);
    expect(coordinator.snapshot.isPlaying).toBe(false);
  });

  it('advances sentences and chapters while play intent remains active', async () => {
    const { audio, synth, coordinator } = setup();
    await coordinator.play();
    audio.emit({ position: 3, didJustFinish: true });
    await tick();
    expect(coordinator.snapshot.sentenceIndex).toBe(1);
    expect(coordinator.snapshot.activeSentenceId).toBe('sentence-1');
    expect(synth.calls).toContain('Four five.');

    audio.emit({ position: 3, didJustFinish: true });
    await tick();
    expect(coordinator.snapshot.chapterIndex).toBe(1);
    expect(coordinator.snapshot.sentenceIndex).toBe(0);
    expect(coordinator.snapshot.activeSentenceId).toBe('sentence-2');
  });

  it('keeps playback paused when synthesis resolves after a pause', async () => {
    const audio = new FakeAudioOutput();
    let resolveAudio!: (audio: SynthesizedAudio) => void;
    const pending = new Promise<SynthesizedAudio>((resolve) => { resolveAudio = resolve; });
    const synth: SpeechSynthesizer = { synthesize: () => pending, release: jest.fn() };
    const coordinator = new PlaybackCoordinator(synth, audio, jest.fn());
    coordinator.setBook(TEST_BOOK);

    const playPromise = coordinator.play();
    coordinator.pause();
    resolveAudio({ uri: 'file://late.wav', duration: 1, wordTimings: [] });
    await playPromise;

    expect(coordinator.snapshot.isPlaying).toBe(false);
    expect(audio.playCount).toBe(0);
  });

  it('seeks explicitly and keeps the selected sentence highlighted while paused', async () => {
    const { coordinator } = setup();
    await coordinator.selectSentence(1);
    expect(coordinator.snapshot.isPlaying).toBe(false);
    expect(coordinator.snapshot.activeSentenceId).toBe('sentence-1');
    expect(coordinator.snapshot.sentenceIndex).toBe(1);
  });

  it('stops cleanly after the final sentence', async () => {
    const { audio, coordinator } = setup();
    coordinator.setBook(TEST_BOOK, { chapterIndex: 1, sentenceIndex: 0 });
    await coordinator.play();
    audio.emit({ position: 3, didJustFinish: true });
    await tick();
    expect(coordinator.snapshot.isPlaying).toBe(false);
    expect(coordinator.snapshot.chapterIndex).toBe(1);
    expect(coordinator.snapshot.sentenceIndex).toBe(0);
  });

  it('resynthesizes the active sentence after a narration-rate change', async () => {
    const { synth, coordinator } = setup();
    await coordinator.play();
    await coordinator.setSpeechRate(1.5);
    expect(coordinator.snapshot.speechRate).toBe(1.5);
    expect(synth.calls).toEqual(['One two three.', 'One two three.']);
  });

  it('releases native audio and model resources', () => {
    const { audio, synth, coordinator } = setup();
    coordinator.release();
    expect(audio.released).toBe(true);
    expect(synth.released).toBe(true);
  });
});
