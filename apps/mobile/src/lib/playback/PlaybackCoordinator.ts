import type { AudioOutput, AudioStatusEvent } from '@/lib/audio/AudioOutput';
import type { SpeechSynthesizer } from '@/lib/tts/InflectSynthesizer';
import type { ReaderBook, ReaderPosition, SynthesizedAudio } from '@/types/reader';

export interface PlaybackState extends ReaderPosition {
  isPlaying: boolean;
  isLoading: boolean;
  activeSentenceId: string | null;
  currentWordIndex: number | null;
  positionSeconds: number;
  durationSeconds: number;
  speechRate: number;
  error: string | null;
}

const INITIAL_STATE: PlaybackState = {
  chapterIndex: 0,
  sentenceIndex: 0,
  isPlaying: false,
  isLoading: false,
  activeSentenceId: null,
  currentWordIndex: null,
  positionSeconds: 0,
  durationSeconds: 0,
  speechRate: 1,
  error: null,
};

export class PlaybackCoordinator {
  private book: ReaderBook | null = null;
  private state: PlaybackState = INITIAL_STATE;
  private audio: SynthesizedAudio | null = null;
  private loadedSentenceId: string | null = null;
  private requestVersion = 0;
  private handlingFinish = false;

  constructor(
    private readonly synthesizer: SpeechSynthesizer,
    private readonly output: AudioOutput,
    private readonly onState: (state: PlaybackState) => void,
  ) {
    output.setStatusListener((status) => this.handleAudioStatus(status));
  }

  get snapshot(): PlaybackState {
    return this.state;
  }

  setBook(book: ReaderBook, position: ReaderPosition = { chapterIndex: 0, sentenceIndex: 0 }): void {
    this.requestVersion += 1;
    this.output.pause();
    this.book = book;
    const chapterIndex = Math.max(0, Math.min(position.chapterIndex, book.chapters.length - 1));
    const chapter = book.chapters[chapterIndex];
    const sentenceIndex = Math.max(0, Math.min(position.sentenceIndex, chapter.sentences.length - 1));
    this.audio = null;
    this.loadedSentenceId = null;
    this.update({
      ...INITIAL_STATE,
      chapterIndex,
      sentenceIndex,
      activeSentenceId: chapter.sentences[sentenceIndex]?.id ?? null,
    });
  }

  async play(): Promise<void> {
    const sentence = this.currentSentence();
    if (!sentence || this.state.isPlaying) return;
    this.update({ isPlaying: true, error: null, activeSentenceId: sentence.id });

    if (this.loadedSentenceId === sentence.id && this.audio) {
      this.output.play();
      return;
    }
    await this.prepareCurrentSentence();
  }

  pause(): void {
    if (!this.book) return;
    this.output.pause();
    this.update({ isPlaying: false, isLoading: false });
  }

  toggle(): Promise<void> | void {
    return this.state.isPlaying ? this.pause() : this.play();
  }

  async next(): Promise<void> {
    await this.skip(1);
  }

  async previous(): Promise<void> {
    await this.skip(-1);
  }

  async selectSentence(sentenceIndex: number): Promise<void> {
    const chapter = this.currentChapter();
    if (!chapter || sentenceIndex < 0 || sentenceIndex >= chapter.sentences.length) return;
    this.requestVersion += 1;
    this.output.pause();
    this.audio = null;
    this.loadedSentenceId = null;
    this.update({
      sentenceIndex,
      activeSentenceId: chapter.sentences[sentenceIndex].id,
      currentWordIndex: null,
      positionSeconds: 0,
      durationSeconds: 0,
      isLoading: this.state.isPlaying,
    });
    if (this.state.isPlaying) await this.prepareCurrentSentence();
  }

  async selectChapter(chapterIndex: number): Promise<void> {
    if (!this.book || chapterIndex < 0 || chapterIndex >= this.book.chapters.length) return;
    this.requestVersion += 1;
    this.output.pause();
    this.audio = null;
    this.loadedSentenceId = null;
    const firstSentence = this.book.chapters[chapterIndex].sentences[0];
    this.update({
      chapterIndex,
      sentenceIndex: 0,
      activeSentenceId: firstSentence?.id ?? null,
      currentWordIndex: null,
      positionSeconds: 0,
      durationSeconds: 0,
      isLoading: this.state.isPlaying,
    });
    if (this.state.isPlaying) await this.prepareCurrentSentence();
  }

  async setSpeechRate(rate: number): Promise<void> {
    const nextRate = Math.max(0.5, Math.min(2, rate));
    if (nextRate === this.state.speechRate) return;
    this.requestVersion += 1;
    this.output.pause();
    this.audio = null;
    this.loadedSentenceId = null;
    this.update({ speechRate: nextRate, positionSeconds: 0, durationSeconds: 0 });
    if (this.state.isPlaying) await this.prepareCurrentSentence();
  }

  setVolume(volume: number): void {
    this.output.setVolume(volume);
  }

  private async skip(direction: -1 | 1): Promise<void> {
    if (!this.move(direction)) return;
    this.requestVersion += 1;
    this.output.pause();
    this.audio = null;
    this.loadedSentenceId = null;
    const sentence = this.currentSentence();
    this.update({
      activeSentenceId: sentence?.id ?? null,
      currentWordIndex: null,
      positionSeconds: 0,
      durationSeconds: 0,
      isLoading: this.state.isPlaying,
    });
    if (this.state.isPlaying) await this.prepareCurrentSentence();
  }

  private async prepareCurrentSentence(): Promise<void> {
    const sentence = this.currentSentence();
    if (!sentence) return;
    const requestVersion = ++this.requestVersion;
    this.update({ isLoading: true, activeSentenceId: sentence.id, currentWordIndex: 0 });
    try {
      const audio = await this.synthesizer.synthesize(sentence.text, this.state.speechRate);
      if (requestVersion !== this.requestVersion) return;
      this.audio = audio;
      this.loadedSentenceId = sentence.id;
      this.output.replace(audio.uri);
      this.output.setRate(1);
      this.update({ isLoading: false, durationSeconds: audio.duration });
      if (this.state.isPlaying) this.output.play();
    } catch (error) {
      if (requestVersion !== this.requestVersion) return;
      this.update({
        isPlaying: false,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Narration failed',
      });
    }
  }

  private handleAudioStatus(status: AudioStatusEvent): void {
    if (status.error) {
      this.update({ isPlaying: false, isLoading: false, error: status.error });
      return;
    }
    const timingIndex = this.audio?.wordTimings.findIndex(
      (timing) => status.position >= timing.start && status.position < timing.end,
    ) ?? -1;
    const fallbackIndex = this.audio?.wordTimings.length ? this.audio.wordTimings.length - 1 : null;
    this.update({
      positionSeconds: status.position,
      durationSeconds: status.duration || this.state.durationSeconds,
      currentWordIndex: timingIndex >= 0 ? timingIndex : status.position > 0 ? fallbackIndex : this.state.currentWordIndex,
    });
    if (status.didJustFinish && this.state.isPlaying && !this.handlingFinish) {
      this.handlingFinish = true;
      void this.advanceAfterFinish().finally(() => {
        this.handlingFinish = false;
      });
    }
  }

  private async advanceAfterFinish(): Promise<void> {
    if (!this.state.isPlaying) return;
    if (!this.move(1)) {
      this.update({ isPlaying: false, currentWordIndex: null });
      return;
    }
    this.audio = null;
    this.loadedSentenceId = null;
    const sentence = this.currentSentence();
    this.update({
      activeSentenceId: sentence?.id ?? null,
      currentWordIndex: 0,
      positionSeconds: 0,
      durationSeconds: 0,
    });
    await this.prepareCurrentSentence();
  }

  private move(direction: -1 | 1): boolean {
    if (!this.book) return false;
    let { chapterIndex, sentenceIndex } = this.state;
    if (direction === 1) {
      const chapter = this.book.chapters[chapterIndex];
      if (sentenceIndex + 1 < chapter.sentences.length) sentenceIndex += 1;
      else if (chapterIndex + 1 < this.book.chapters.length) {
        chapterIndex += 1;
        sentenceIndex = 0;
      } else return false;
    } else if (sentenceIndex > 0) sentenceIndex -= 1;
    else if (chapterIndex > 0) {
      chapterIndex -= 1;
      sentenceIndex = this.book.chapters[chapterIndex].sentences.length - 1;
    } else return false;
    this.update({ chapterIndex, sentenceIndex });
    return true;
  }

  private currentChapter() {
    return this.book?.chapters[this.state.chapterIndex] ?? null;
  }

  private currentSentence() {
    return this.currentChapter()?.sentences[this.state.sentenceIndex] ?? null;
  }

  private update(patch: Partial<PlaybackState> | PlaybackState): void {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  release(): void {
    this.requestVersion += 1;
    this.output.release();
    this.synthesizer.release();
    this.book = null;
  }
}
