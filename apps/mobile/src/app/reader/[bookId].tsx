import { useEffect, useMemo, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { PlaybackControls } from '@/components/PlaybackControls';
import { ReaderText } from '@/components/ReaderText';
import { colors } from '@/constants/theme';
import { useReaderPlayback } from '@/hooks/useReaderPlayback';
import { libraryRepository } from '@/lib/storage/libraryRepository';
import type { ReaderBook, ReaderPosition } from '@/types/reader';

const ZERO_POSITION: ReaderPosition = { chapterIndex: 0, sentenceIndex: 0 };

export default function ReaderScreen() {
  const params = useLocalSearchParams<{ bookId: string }>();
  const bookId = Array.isArray(params.bookId) ? params.bookId[0] : params.bookId;
  const [book, setBook] = useState<ReaderBook | null>(null);
  const [initialPosition, setInitialPosition] = useState<ReaderPosition>(ZERO_POSITION);
  const [isReady, setIsReady] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const playback = useReaderPlayback(book, initialPosition);

  useEffect(() => {
    let active = true;
    void Promise.all([libraryRepository.getBook(bookId), libraryRepository.getProgress(bookId)])
      .then(([nextBook, progress]) => {
        if (!active) return;
        setBook(nextBook);
        setInitialPosition(progress);
        setIsReady(true);
      });
    return () => { active = false; };
  }, [bookId]);

  const chapter = book?.chapters[playback.state.chapterIndex] ?? null;
  const totalSentences = useMemo(
    () => book?.chapters.reduce((total, item) => total + item.sentences.length, 0) ?? 0,
    [book],
  );
  const completedSentences = useMemo(() => {
    if (!book) return 0;
    let total = playback.state.sentenceIndex;
    for (let index = 0; index < playback.state.chapterIndex; index++) total += book.chapters[index].sentences.length;
    return total;
  }, [book, playback.state.chapterIndex, playback.state.sentenceIndex]);
  const progress = totalSentences > 1 ? completedSentences / (totalSentences - 1) : 0;
  const canGoPrevious = playback.state.chapterIndex > 0 || playback.state.sentenceIndex > 0;
  const canGoNext = Boolean(book && (
    playback.state.sentenceIndex < (chapter?.sentences.length ?? 0) - 1 ||
    playback.state.chapterIndex < book.chapters.length - 1
  ));

  if (!isReady) {
    return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;
  }
  if (!book || !chapter) {
    return <View style={styles.center}><Text style={styles.error}>This book is no longer in the library.</Text></View>;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen options={{ title: book.title }} />
      <View style={styles.chapterHeader}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open table of contents"
          onPress={() => setShowChapters(true)}
          style={styles.chapterButton}
          testID="chapter-picker-button"
        >
          <Text numberOfLines={1} style={styles.chapterTitle}>{chapter.title}</Text>
          <Text style={styles.chapterMeta}>Chapter {playback.state.chapterIndex + 1} of {book.chapters.length}⌄</Text>
        </Pressable>
        <Text style={styles.progressLabel}>{Math.round(progress * 100)}%</Text>
      </View>
      <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress * 100}%` }]} /></View>

      <ReaderText
        activeSentenceId={playback.state.activeSentenceId}
        currentWordIndex={playback.state.currentWordIndex}
        onSentencePress={(index) => void playback.selectSentence(index)}
        sentences={chapter.sentences}
      />

      {playback.modelProgress && playback.modelProgress.completedFiles < playback.modelProgress.totalFiles ? (
        <Text style={styles.modelStatus} testID="model-download-progress">
          Preparing Sky v3 · {playback.modelProgress.completedFiles}/{playback.modelProgress.totalFiles}
        </Text>
      ) : null}
      {playback.state.error ? <Text accessibilityRole="alert" style={styles.errorBanner}>{playback.state.error}</Text> : null}

      <PlaybackControls
        canGoNext={canGoNext}
        canGoPrevious={canGoPrevious}
        isLoading={playback.state.isLoading}
        isPlaying={playback.state.isPlaying}
        onNext={() => void playback.next()}
        onPrevious={() => void playback.previous()}
        onRateChange={(rate) => void playback.setSpeechRate(rate)}
        onToggle={() => void playback.toggle()}
        speechRate={playback.state.speechRate}
      />

      <Modal animationType="slide" onRequestClose={() => setShowChapters(false)} transparent visible={showChapters}>
        <Pressable onPress={() => setShowChapters(false)} style={styles.modalBackdrop}>
          <Pressable accessibilityRole="menu" onPress={() => undefined} style={styles.chapterSheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Table of contents</Text>
            <FlatList
              data={book.chapters}
              keyExtractor={(item) => item.id}
              renderItem={({ item, index }) => (
                <Pressable
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: index === playback.state.chapterIndex }}
                  onPress={() => {
                    setShowChapters(false);
                    void playback.selectChapter(index);
                  }}
                  style={[styles.chapterRow, index === playback.state.chapterIndex && styles.activeChapterRow]}
                  testID={`chapter-${index}`}
                >
                  <Text style={styles.chapterNumber}>{String(index + 1).padStart(2, '0')}</Text>
                  <Text numberOfLines={2} style={styles.chapterRowTitle}>{item.title}</Text>
                </Pressable>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.paper, flex: 1 },
  center: { alignItems: 'center', backgroundColor: colors.canvas, flex: 1, justifyContent: 'center' },
  chapterHeader: { alignItems: 'center', backgroundColor: colors.canvas, flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 10 },
  chapterButton: { flex: 1 },
  chapterTitle: { color: colors.ink, fontFamily: 'Georgia', fontSize: 17, fontWeight: '700' },
  chapterMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  progressLabel: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  progressTrack: { backgroundColor: colors.border, height: 2 },
  progressFill: { backgroundColor: colors.accent, height: 2 },
  modelStatus: { backgroundColor: colors.canvas, color: colors.muted, fontSize: 12, padding: 7, textAlign: 'center' },
  error: { color: colors.danger, padding: 24, textAlign: 'center' },
  errorBanner: { backgroundColor: '#FBE3DF', color: colors.danger, padding: 8, textAlign: 'center' },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.35)', flex: 1, justifyContent: 'flex-end' },
  chapterSheet: { backgroundColor: colors.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '72%', paddingBottom: 24, paddingHorizontal: 18 },
  sheetHandle: { alignSelf: 'center', backgroundColor: colors.border, borderRadius: 2, height: 4, marginVertical: 10, width: 44 },
  sheetTitle: { color: colors.ink, fontFamily: 'Georgia', fontSize: 24, fontWeight: '700', marginBottom: 12 },
  chapterRow: { alignItems: 'center', borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 14, padding: 14 },
  activeChapterRow: { backgroundColor: colors.sentence },
  chapterNumber: { color: colors.accent, fontSize: 12, fontWeight: '900' },
  chapterRowTitle: { color: colors.ink, flex: 1, fontFamily: 'Georgia', fontSize: 16 },
});
