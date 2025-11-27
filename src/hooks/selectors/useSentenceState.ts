import { useSentenceStateStore } from '@/store/sentenceStateStore';
import { useNavigationStore } from '@/store/navigationStore';

export const useTimelineState = () => {
  const sentenceStates = useSentenceStateStore(state => state.sentenceStates);
  const highlightedSentenceId = useSentenceStateStore(state => state.highlightedSentenceId);
  const currentSentenceIndex = useNavigationStore(state => state.currentSentenceIndex);

  return { sentenceStates, highlightedSentenceId, currentSentenceIndex };
};

export const useHighlightState = () => useSentenceStateStore(state => ({
  highlightedSentenceId: state.highlightedSentenceId,
  highlightedWordIndex: state.highlightedWordIndex
}));

export const useSentenceStateActions = () => useSentenceStateStore(state => ({
  setSentenceState: state.setSentenceState,
  setSentenceStates: state.setSentenceStates,
  clearSentenceStates: state.clearSentenceStates,
  setHighlight: state.setHighlight,
  clearHighlight: state.clearHighlight
}));
