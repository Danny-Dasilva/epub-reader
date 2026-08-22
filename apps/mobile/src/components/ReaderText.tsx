import { memo, useEffect, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type ListRenderItemInfo } from 'react-native';

import { colors } from '@/constants/theme';
import type { ReaderSentence } from '@/types/reader';

interface SentenceLineProps {
  sentence: ReaderSentence;
  sentenceIndex: number;
  isActive: boolean;
  currentWordIndex: number | null;
  onPress: (index: number) => void;
}

const PARTS = /(\s+|\S+)/gu;

const SentenceLine = memo(function SentenceLine({
  sentence,
  sentenceIndex,
  isActive,
  currentWordIndex,
  onPress,
}: SentenceLineProps) {
  let wordIndex = 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Sentence ${sentenceIndex + 1}: ${sentence.text}`}
      accessibilityState={{ selected: isActive }}
      onPress={() => onPress(sentenceIndex)}
      style={[styles.sentence, isActive && styles.activeSentence]}
      testID={`sentence-${sentenceIndex}`}
    >
      <Text style={styles.bodyText}>
        {sentence.text.split(PARTS).filter(Boolean).map((part, partIndex) => {
          if (/^\s+$/u.test(part)) return part;
          const index = wordIndex++;
          const isCurrent = isActive && currentWordIndex === index;
          const isSpoken = isActive && currentWordIndex !== null && index < currentWordIndex;
          return (
            <Text
              accessibilityLabel={isCurrent ? `Current word: ${part}` : part}
              accessibilityState={{ selected: isCurrent }}
              key={`${partIndex}-${part}`}
              style={[isSpoken && styles.spokenWord, isCurrent && styles.currentWord]}
              testID={`sentence-${sentenceIndex}-word-${index}`}
            >
              {part}
            </Text>
          );
        })}
      </Text>
    </Pressable>
  );
});

interface ReaderTextProps {
  sentences: ReaderSentence[];
  activeSentenceId: string | null;
  currentWordIndex: number | null;
  onSentencePress: (index: number) => void;
}

export function ReaderText({
  sentences,
  activeSentenceId,
  currentWordIndex,
  onSentencePress,
}: ReaderTextProps) {
  const listRef = useRef<FlatList<ReaderSentence>>(null);
  const activeIndex = sentences.findIndex((sentence) => sentence.id === activeSentenceId);

  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.scrollToIndex({ index: activeIndex, animated: true, viewPosition: 0.38 });
  }, [activeIndex]);

  const renderItem = ({ item, index }: ListRenderItemInfo<ReaderSentence>) => (
    <SentenceLine
      sentence={item}
      sentenceIndex={index}
      isActive={item.id === activeSentenceId}
      currentWordIndex={item.id === activeSentenceId ? currentWordIndex : null}
      onPress={onSentencePress}
    />
  );

  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={sentences}
      initialNumToRender={14}
      keyExtractor={(sentence) => sentence.id}
      ListFooterComponent={<View style={styles.footer} />}
      onScrollToIndexFailed={({ index }) => {
        listRef.current?.scrollToOffset({ offset: Math.max(0, index * 82), animated: true });
      }}
      ref={listRef}
      renderItem={renderItem}
      testID="reader-sentence-list"
      windowSize={9}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 22 },
  sentence: { borderRadius: 8, marginBottom: 3, paddingHorizontal: 9, paddingVertical: 6 },
  activeSentence: { backgroundColor: colors.sentence },
  bodyText: { color: colors.ink, fontFamily: 'Georgia', fontSize: 20, lineHeight: 32 },
  spokenWord: { backgroundColor: colors.spokenWord },
  currentWord: { backgroundColor: colors.currentWord, color: colors.white },
  footer: { height: 140 },
});
