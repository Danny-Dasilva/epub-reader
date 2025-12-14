'use client';

import { useCallback, useMemo, ReactNode } from 'react';
import { Sentence, BlockType } from '@/lib/epub';
import { SentenceStateMap, TimestampSource } from '@/store/sentenceStateStore';
import { SentenceSpan } from './SentenceSpan';

interface VirtualizedSentenceListProps {
  sentences: Sentence[];
  sentenceStates: SentenceStateMap;
  currentIndex: number;
  highlightedSentenceId: string | null;
  highlightedWordIndex: number | null;
  highlightTimestampSource: TimestampSource | null;
  onSentenceClick: (index: number) => void;
  isPlaying: boolean;
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
 * Sentence list component that renders all sentences grouped by blocks.
 * Preserves paragraph structure and other block-level formatting from the EPUB.
 */
export function VirtualizedSentenceList({
  sentences,
  sentenceStates,
  highlightedSentenceId,
  highlightedWordIndex,
  highlightTimestampSource,
  onSentenceClick,
}: VirtualizedSentenceListProps) {
  const handleClick = useCallback((index: number) => {
    onSentenceClick(index);
  }, [onSentenceClick]);

  // Group sentences into blocks for structured rendering
  const blocks = useMemo(() => groupSentencesByBlock(sentences), [sentences]);

  return (
    <div className="leading-relaxed prose-blocks">
      {blocks.map((block, blockIndex) => (
        <BlockContainer
          key={`block-${blockIndex}`}
          type={block.type}
          level={block.level}
          isFirst={blockIndex === 0}
        >
          {block.sentences.map(({ sentence, globalIndex }) => {
            const isActive = highlightedSentenceId === sentence.id;
            const state = sentenceStates[sentence.id];

            return (
              <SentenceSpan
                key={sentence.id}
                sentence={sentence}
                index={globalIndex}
                state={state}
                isHighlighted={isActive}
                highlightedWordIndex={isActive ? highlightedWordIndex : null}
                timestampSource={isActive ? highlightTimestampSource : null}
                onClick={() => handleClick(globalIndex)}
              />
            );
          })}
        </BlockContainer>
      ))}
    </div>
  );
}
