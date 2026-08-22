import { fireEvent, render, screen } from '@testing-library/react-native';

import { ReaderText } from '@/components/ReaderText';
import { TEST_BOOK } from '@/testing/fixtures';

describe('ReaderText highlighting', () => {
  const sentences = TEST_BOOK.chapters[0].sentences;

  it('retains sentence-level highlighting as the active line changes', () => {
    const view = render(
      <ReaderText
        activeSentenceId="sentence-0"
        currentWordIndex={0}
        onSentencePress={jest.fn()}
        sentences={sentences}
      />,
    );
    expect(screen.getByTestId('sentence-0')).toBeSelected();
    expect(screen.getByTestId('sentence-1')).not.toBeSelected();

    view.rerender(
      <ReaderText
        activeSentenceId="sentence-1"
        currentWordIndex={0}
        onSentencePress={jest.fn()}
        sentences={sentences}
      />,
    );
    expect(screen.getByTestId('sentence-0')).not.toBeSelected();
    expect(screen.getByTestId('sentence-1')).toBeSelected();
  });

  it('marks exactly the current word within the active sentence', () => {
    const view = render(
      <ReaderText
        activeSentenceId="sentence-0"
        currentWordIndex={1}
        onSentencePress={jest.fn()}
        sentences={sentences}
      />,
    );
    expect(screen.getByTestId('sentence-0-word-0')).not.toBeSelected();
    expect(screen.getByTestId('sentence-0-word-1')).toBeSelected();
    expect(screen.getByTestId('sentence-0-word-2')).not.toBeSelected();
    expect(screen.getByTestId('active-word-0-1')).toBeSelected();

    view.rerender(
      <ReaderText
        activeSentenceId="sentence-0"
        currentWordIndex={2}
        onSentencePress={jest.fn()}
        sentences={sentences}
      />,
    );
    expect(screen.getByTestId('sentence-0-word-1')).not.toBeSelected();
    expect(screen.getByTestId('sentence-0-word-2')).toBeSelected();
    expect(screen.getByTestId('active-word-0-2')).toBeSelected();
  });

  it('seeks narration when a sentence is pressed', () => {
    const onSentencePress = jest.fn();
    render(
      <ReaderText
        activeSentenceId="sentence-0"
        currentWordIndex={null}
        onSentencePress={onSentencePress}
        sentences={sentences}
      />,
    );
    fireEvent.press(screen.getByTestId('sentence-1'));
    expect(onSentencePress).toHaveBeenCalledWith(1);
  });
});
