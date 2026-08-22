export interface AudioStatusEvent {
  position: number;
  duration: number;
  playing: boolean;
  didJustFinish: boolean;
  error?: string | null;
}

export interface AudioOutput {
  replace(uri: string): void;
  play(): void;
  pause(): void;
  seek(position: number): Promise<void>;
  setRate(rate: number): void;
  setVolume(volume: number): void;
  setStatusListener(listener: (status: AudioStatusEvent) => void): void;
  release(): void;
}
