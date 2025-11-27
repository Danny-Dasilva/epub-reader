import { usePlaybackStore } from '@/store/playbackStore';

export const usePlaybackState = () => usePlaybackStore(state => ({
  isPlaying: state.isPlaying,
  audioPlaybackRate: state.audioPlaybackRate,
  volume: state.volume,
  speechRate: state.speechRate
}));

export const usePlaybackActions = () => usePlaybackStore(state => ({
  setIsPlaying: state.setIsPlaying,
  setVolume: state.setVolume,
  setSpeechRate: state.setSpeechRate,
  setAudioPlaybackRate: state.setAudioPlaybackRate
}));

export const usePlaybackSession = () => usePlaybackStore(state => ({
  session: state.session,
  startSession: state.startSession,
  endSession: state.endSession,
  setPaused: state.setPaused,
  updateSessionSentence: state.updateSessionSentence
}));
