import { useNavigationStore } from '@/store/navigationStore';

export const useNavigationState = () => useNavigationStore(state => ({
  currentBook: state.currentBook,
  currentChapterIndex: state.currentChapterIndex,
  currentSentenceIndex: state.currentSentenceIndex
}));

export const useNavigationActions = () => useNavigationStore(state => ({
  setCurrentBook: state.setCurrentBook,
  setChapter: state.setChapter,
  setSentenceIndex: state.setSentenceIndex,
  nextSentence: state.nextSentence,
  prevSentence: state.prevSentence,
  nextChapter: state.nextChapter,
  prevChapter: state.prevChapter,
  getCurrentChapter: state.getCurrentChapter,
  getCurrentSentence: state.getCurrentSentence
}));

export const useCurrentContent = () => useNavigationStore(state => ({
  getCurrentChapter: state.getCurrentChapter,
  getCurrentSentence: state.getCurrentSentence
}));
