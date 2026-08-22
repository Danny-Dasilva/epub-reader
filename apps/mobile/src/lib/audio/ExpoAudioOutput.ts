import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import type { AudioOutput, AudioStatusEvent } from './AudioOutput';

export class ExpoAudioOutput implements AudioOutput {
  private readonly player: AudioPlayer;
  private readonly subscription: { remove(): void };
  private statusListener: ((status: AudioStatusEvent) => void) | null = null;

  constructor() {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    });
    this.player = createAudioPlayer(null, { updateInterval: 50 });
    this.subscription = this.player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      this.statusListener?.({
        position: status.currentTime,
        duration: status.duration,
        playing: status.playing,
        didJustFinish: status.didJustFinish,
        error: status.error,
      });
    });
  }

  replace(uri: string): void {
    this.player.replace({ uri });
  }

  play(): void {
    this.player.play();
  }

  pause(): void {
    this.player.pause();
  }

  seek(position: number): Promise<void> {
    return this.player.seekTo(position);
  }

  setRate(rate: number): void {
    this.player.setPlaybackRate(Math.max(0.5, Math.min(2, rate)));
  }

  setVolume(volume: number): void {
    this.player.volume = Math.max(0, Math.min(1, volume));
  }

  setStatusListener(listener: (status: AudioStatusEvent) => void): void {
    this.statusListener = listener;
  }

  release(): void {
    this.subscription.remove();
    this.player.pause();
    this.player.remove();
    this.statusListener = null;
  }
}
