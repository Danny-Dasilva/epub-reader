'use client';

import { memo, useCallback, useMemo, ReactNode } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Sentence, BlockType } from '@/lib/epub/types';
import { TimestampSource, useSentenceStateStore } from '@/store/sentenceStateStore';
import { SentenceSpan } from './SentenceSpan';

// Hoisted outside component to avoid recreating on every render
const virtuosoComponents = {
  List: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
    <div {...props} className="leading-relaxed prose-blocks">
      {children}
    </div>
  )
};

interface VirtualizedSentenceListProps {
  sentences: Sentence[];
  highlightedSentenceId: string | null;
  highlightedWordIndex: number | null;
  highlightTimestampSource: TimestampSource | null;
  onSentenceClick: (index: number) => void;
}

interface SentenceBlock {
  type: BlockType | undefined;
  level: number | undefined;
  sentences: Array<{ sentence: Sentence; globalIndex: number }>;
}

/**
 * Group consecutive sentences into blocks based on their block metadata
 */
function groupSentencesByBlock(sentences: Sentence[]): SentenceBlock[] {
  const blocks: SentenceBlock[] = [];
  let currentBlock: SentenceBlock | null = null;

  sentences.forEach((sentence, index) => {
    // Start a new block if:
    // 1. No current block
    // 2. This sentence starts a new block
    // 3. Block type changed
    if (
      !currentBlock ||
      sentence.isBlockStart ||
      currentBlock.type !== sentence.blockType
    ) {
      currentBlock = {
        type: sentence.blockType,
        level: sentence.blockLevel,
        sentences: []
      };
      blocks.push(currentBlock);
    }

    currentBlock.sentences.push({ sentence, globalIndex: index });
  });

  return blocks;
}

/**
 * Container component for different block types
 */
function BlockContainer({
  type,
  level,
  isFirst,
  children
}: {
  type: BlockType | undefined;
  level: number | undefined;
  isFirst: boolean;
  children: ReactNode;
}) {
  switch (type) {
    case 'paragraph':
      return (
        <p className={`block-paragraph ${isFirst ? 'first' : ''}`}>
          {children}
        </p>
      );
    case 'list-item':
      return (
        <div className={`block-list-item level-${level || 1}`}>
          {children}
        </div>
      );
    case 'blockquote':
      return (
        <blockquote className="block-blockquote">
          {children}
        </blockquote>
      );
    case 'heading': {
      // Use appropriate heading level, default to h2
      const headingLevel = Math.min(Math.max(level || 2, 1), 6);
      const className = `block-heading level-${level || 2}`;
      switch (headingLevel) {
        case 1: return <h1 className={className}>{children}</h1>;
        case 2: return <h2 className={className}>{children}</h2>;
        case 3: return <h3 className={className}>{children}</h3>;
        case 4: return <h4 className={className}>{children}</h4>;
        case 5: return <h5 className={className}>{children}</h5>;
        case 6: return <h6 className={className}>{children}</h6>;
        default: return <h2 className={className}>{children}</h2>;
      }
    }
    default:
      // No block type - render inline
      return <>{children}</>;
  }
}

/**
 * Wrapper component that subscribes to individual sentence state.
 * This ensures each sentence only re-renders when its own state changes.
 *
 * rerender-memo: Memoized with a custom comparator so a new inline onClick
 * arrow (created per itemContent call) does not trigger a re-render — the
 * comparator intentionally skips onClick, matching SentenceSpan's own
 * memo comparator. The stable `onSentenceClick` prop is the real callback.
 */
const SentenceWithState = memo(function SentenceWithState({
  sentence,
  globalIndex,
  isActive,
  highlightedWordIndex,
  timestampSource,
  onSentenceClick,
}: {
  sentence: Sentence;
  globalIndex: number;
  isActive: boolean;
  highlightedWordIndex: number | null;
  timestampSource: TimestampSource | null;
  onSentenceClick: (index: number) => void;
}) {
  // Subscribe only to this sentence's state - prevents re-renders when other sentences change
  const state = useSentenceStateStore(store => store.sentenceStates[sentence.id]);

  // rerender-functional-setstate / stable handler: build the click handler
  // inside the component so it captures stable `globalIndex` without
  // forcing the parent to allocate a new closure per row per render.
  const handleClick = useCallback(() => {
    onSentenceClick(globalIndex);
  }, [onSentenceClick, globalIndex]);

  return (
    <SentenceSpan
      sentence={sentence}
      index={globalIndex}
      state={state}
      isHighlighted={isActive}
      highlightedWordIndex={isActive ? highlightedWordIndex : null}
      timestampSource={isActive ? timestampSource : null}
      onClick={handleClick}
    />
  );
}, (prev, next) => {
  // Custom comparator: skip re-render when only the parent's inline onClick
  // reference changes. All other props must match exactly.
  return (
    prev.sentence === next.sentence &&
    prev.globalIndex === next.globalIndex &&
    prev.isActive === next.isActive &&
    prev.highlightedWordIndex === next.highlightedWordIndex &&
    prev.timestampSource === next.timestampSource &&
    prev.onSentenceClick === next.onSentenceClick
  );
});

/**
 * Virtualized sentence list component that renders blocks efficiently.
 * Uses react-virtuoso for optimal performance with large documents.
 *
 * Optimizations applied:
 * - Low overscan (2 items) to minimize off-screen rendering
 * - Memoized itemContent callback with stable dependencies
 * - computeItemKey for stable React keys
 * - Individual SentenceSpan components subscribe to their own state via SentenceWithState
 */
export function VirtualizedSentenceList({
  sentences,
  highlightedSentenceId,
  highlightedWordIndex,
  highlightTimestampSource,
  onSentenceClick,
}: VirtualizedSentenceListProps) {
  // Stable callback for sentence clicks
  const handleClick = useCallback((index: number) => {
    onSentenceClick(index);
  }, [onSentenceClick]);

  // Group sentences into blocks for structured rendering
  const blocks = useMemo(() => groupSentencesByBlock(sentences), [sentences]);

  // Stable computeItemKey - returns unique stable identifier for each block
  // Uses first sentence ID to ensure stability across re-renders
  const computeItemKey = useCallback((index: number) => {
    const block = blocks[index];
    if (!block || block.sentences.length === 0) return `block-${index}`;
    // Use first sentence ID as block key for stability
    return `block-${block.sentences[0].sentence.id}`;
  }, [blocks]);

  // Memoized itemContent callback with stable dependencies
  // Only re-creates when essential dependencies change
  // This prevents unnecessary re-renders of off-screen items
  const itemContent = useCallback((index: number) => {
    const block = blocks[index];
    if (!block) return null;

    return (
      // rendering-content-visibility: defer layout/paint for off-screen blocks.
      // contain-intrinsic-size hints the browser at ~120px per block so scrollbar
      // sizing stays accurate before the block is rendered.
      <div style={{ contentVisibility: 'auto', containIntrinsicSize: '0 120px' }}>
        <BlockContainer
          type={block.type}
          level={block.level}
          isFirst={index === 0}
        >
          {block.sentences.map(({ sentence, globalIndex }) => {
            const isActive = highlightedSentenceId === sentence.id;

            return (
              <SentenceWithState
                key={sentence.id}
                sentence={sentence}
                globalIndex={globalIndex}
                isActive={isActive}
                highlightedWordIndex={highlightedWordIndex}
                timestampSource={highlightTimestampSource}
                onSentenceClick={handleClick}
              />
            );
          })}
        </BlockContainer>
      </div>
    );
  }, [
    blocks,
    highlightedSentenceId,
    highlightedWordIndex,
    highlightTimestampSource,
    handleClick
  ]);

  return (
    <Virtuoso
      useWindowScroll
      totalCount={blocks.length}
      overscan={2}
      computeItemKey={computeItemKey}
      itemContent={itemContent}
      components={virtuosoComponents}
    />
  );
}
