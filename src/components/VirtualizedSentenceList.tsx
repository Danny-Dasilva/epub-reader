'use client';

import {
  memo,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  forwardRef,
  ReactNode,
} from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { Sentence, BlockType, ChapterImage } from '@/lib/epub/types';
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
  images?: ChapterImage[];
  highlightedSentenceId: string | null;
  highlightedWordIndex: number | null;
  highlightTimestampSource: TimestampSource | null;
  onSentenceClick: (index: number) => void;
}

/**
 * Imperative handle exposed to parents so they can jump to an arbitrary
 * sentence even when it is virtualized out of the DOM. `scrollToSentence`
 * routes through Virtuoso's `scrollToIndex`, which mounts the target row before
 * scrolling — unlike `document.getElementById`, which only works for currently
 * mounted rows. See BUG 4 (search-result jump to far-down sentence).
 */
export interface VirtualizedSentenceListHandle {
  scrollToSentence: (sentenceIndex: number) => void;
}

interface SentenceBlock {
  type: BlockType | undefined;
  level: number | undefined;
  sentences: Array<{ sentence: Sentence; globalIndex: number }>;
}

/**
 * A renderable Virtuoso item: either a block of sentences or a standalone
 * inline image. Image items are display-only — they are NOT sentences, carry
 * no `sentence-${index}` id, and never affect sentence indexing/TTS.
 */
type RenderItem =
  | { kind: 'block'; block: SentenceBlock }
  | { kind: 'image'; image: ChapterImage };

/**
 * Interleave inline images with sentence blocks.
 *
 * Each image declares the sentence index it should appear BEFORE. We walk the
 * grouped blocks in order and emit any pending images whose target sentence
 * index is <= the first sentence index of the upcoming block. Remaining images
 * (target index past the last sentence) are appended at the end.
 */
function buildRenderItems(blocks: SentenceBlock[], images: ChapterImage[]): RenderItem[] {
  if (images.length === 0) {
    return blocks.map(block => ({ kind: 'block', block }));
  }

  // Stable ascending order by target sentence index.
  const sortedImages = [...images].sort((a, b) => a.sentenceIndex - b.sentenceIndex);
  const items: RenderItem[] = [];
  let imgIdx = 0;

  for (const block of blocks) {
    const blockStart = block.sentences.length > 0 ? block.sentences[0].globalIndex : Infinity;
    // Emit images anchored before this block's first sentence.
    while (imgIdx < sortedImages.length && sortedImages[imgIdx].sentenceIndex <= blockStart) {
      items.push({ kind: 'image', image: sortedImages[imgIdx] });
      imgIdx++;
    }
    items.push({ kind: 'block', block });
  }

  // Trailing images (after the last sentence).
  while (imgIdx < sortedImages.length) {
    items.push({ kind: 'image', image: sortedImages[imgIdx] });
    imgIdx++;
  }

  return items;
}

/**
 * Map a global sentence index to the Virtuoso render-item index that contains
 * it. Render items interleave display-only image items with sentence blocks, so
 * the render-item index does NOT equal the sentence index. We locate the block
 * whose sentence range covers the target index.
 *
 * Returns -1 if no block contains the index (e.g. out-of-range).
 */
function sentenceIndexToItemIndex(renderItems: RenderItem[], sentenceIndex: number): number {
  for (let i = 0; i < renderItems.length; i++) {
    const item = renderItems[i];
    if (item.kind !== 'block') continue;
    const s = item.block.sentences;
    if (s.length === 0) continue;
    const first = s[0].globalIndex;
    const last = s[s.length - 1].globalIndex;
    if (sentenceIndex >= first && sentenceIndex <= last) {
      return i;
    }
  }
  return -1;
}

/**
 * Standalone inline image rendered between sentence blocks.
 * Uses native lazy loading and responsive sizing. Not a sentence: no
 * `sentence-${index}` id, not clickable for playback, never sent to TTS.
 */
const ImageBlock = memo(function ImageBlock({ image }: { image: ChapterImage }) {
  return (
    <figure className="block-image" style={{ margin: '1.5em 0', textAlign: 'center' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.src}
        alt={image.alt}
        loading="lazy"
        decoding="async"
        style={{ maxWidth: '100%', height: 'auto', display: 'inline-block' }}
      />
      {image.alt ? (
        <figcaption
          className="block-image-caption"
          style={{ fontSize: '0.85em', opacity: 0.7, marginTop: '0.5em' }}
        >
          {image.alt}
        </figcaption>
      ) : null}
    </figure>
  );
});

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
export const VirtualizedSentenceList = forwardRef<
  VirtualizedSentenceListHandle,
  VirtualizedSentenceListProps
>(function VirtualizedSentenceList({
  sentences,
  images,
  highlightedSentenceId,
  highlightedWordIndex,
  highlightTimestampSource,
  onSentenceClick,
}, ref) {
  // Stable callback for sentence clicks
  const handleClick = useCallback((index: number) => {
    onSentenceClick(index);
  }, [onSentenceClick]);

  // Group sentences into blocks for structured rendering
  const blocks = useMemo(() => groupSentencesByBlock(sentences), [sentences]);

  // Interleave inline image items with sentence blocks. Images are display-only
  // and do not participate in sentence indexing.
  const renderItems = useMemo(
    () => buildRenderItems(blocks, images ?? []),
    [blocks, images]
  );

  // Imperative handle to Virtuoso so parents can jump to a sentence even when
  // it is virtualized out of the DOM. See BUG 4.
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useImperativeHandle(ref, () => ({
    scrollToSentence: (sentenceIndex: number) => {
      const itemIndex = sentenceIndexToItemIndex(renderItems, sentenceIndex);
      if (itemIndex < 0) return;
      virtuosoRef.current?.scrollToIndex({
        index: itemIndex,
        align: 'center',
        behavior: 'smooth',
      });
    },
  }), [renderItems]);

  // Stable computeItemKey - returns unique stable identifier for each item
  const computeItemKey = useCallback((index: number) => {
    const item = renderItems[index];
    if (!item) return `item-${index}`;
    if (item.kind === 'image') return `image-${item.image.id}`;
    const block = item.block;
    if (block.sentences.length === 0) return `block-${index}`;
    return `block-${block.sentences[0].sentence.id}`;
  }, [renderItems]);

  // Memoized itemContent callback with stable dependencies
  const itemContent = useCallback((index: number) => {
    const item = renderItems[index];
    if (!item) return null;

    if (item.kind === 'image') {
      // Image blocks get their own measured height via Virtuoso; do not force a
      // fixed intrinsic size so the natural image height is measured correctly.
      return <ImageBlock image={item.image} />;
    }

    const block = item.block;
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
    renderItems,
    highlightedSentenceId,
    highlightedWordIndex,
    highlightTimestampSource,
    handleClick
  ]);

  return (
    <Virtuoso
      ref={virtuosoRef}
      useWindowScroll
      totalCount={renderItems.length}
      overscan={2}
      computeItemKey={computeItemKey}
      itemContent={itemContent}
      components={virtuosoComponents}
    />
  );
});
