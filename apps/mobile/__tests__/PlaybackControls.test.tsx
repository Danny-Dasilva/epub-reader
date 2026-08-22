import { fireEvent, render, screen } from '@testing-library/react-native';

import { PlaybackControls } from '@/components/PlaybackControls';

const defaults = {
  isPlaying: false,
  isLoading: false,
  speechRate: 1,
  canGoPrevious: true,
  canGoNext: true,
  onToggle: jest.fn(),
  onPrevious: jest.fn(),
  onNext: jest.fn(),
  onRateChange: jest.fn(),
};

describe('PlaybackControls', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exposes play and invokes the toggle action', () => {
    render(<PlaybackControls {...defaults} />);
    fireEvent.press(screen.getByRole('button', { name: 'Play narration' }));
    expect(defaults.onToggle).toHaveBeenCalledTimes(1);
  });

  it('exposes pause while audio is playing, including during a handoff load', () => {
    render(<PlaybackControls {...defaults} isLoading isPlaying />);
    const button = screen.getByRole('button', { name: 'Pause narration' });
    expect(button).toBeBusy();
    expect(button).toBeSelected();
    fireEvent.press(button);
    expect(defaults.onToggle).toHaveBeenCalledTimes(1);
  });

  it('disables unavailable previous and next actions', () => {
    render(<PlaybackControls {...defaults} canGoNext={false} canGoPrevious={false} />);
    fireEvent.press(screen.getByTestId('previous-button'));
    fireEvent.press(screen.getByTestId('next-button'));
    expect(defaults.onPrevious).not.toHaveBeenCalled();
    expect(defaults.onNext).not.toHaveBeenCalled();
  });

  it('cycles the narration rate', () => {
    render(<PlaybackControls {...defaults} speechRate={1.2} />);
    fireEvent.press(screen.getByTestId('rate-button'));
    expect(defaults.onRateChange).toHaveBeenCalledWith(1.5);
  });
});
