import { useUIStore } from '@/store/uiStore';

export const useUIState = () => useUIStore(state => ({
  theme: state.theme,
  fontSize: state.fontSize,
  showToc: state.showToc,
  showSettings: state.showSettings
}));

export const useUIActions = () => useUIStore(state => ({
  setTheme: state.setTheme,
  setFontSize: state.setFontSize,
  setShowToc: state.setShowToc,
  setShowSettings: state.setShowSettings,
  toggleSettings: state.toggleSettings
}));
