import { useTTSStore } from '@/store/ttsStore';

export const useTTSState = () => useTTSStore(state => ({
  ttsReady: state.ttsReady,
  ttsLoading: state.ttsLoading,
  ttsBackend: state.ttsBackend,
  currentVoice: state.currentVoice
}));

export const useTTSActions = () => useTTSStore(state => ({
  setTTSReady: state.setTTSReady,
  setTTSLoading: state.setTTSLoading,
  setTTSBackend: state.setTTSBackend,
  setCurrentVoice: state.setCurrentVoice
}));
