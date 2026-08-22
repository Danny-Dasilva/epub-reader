import { useCallback, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors } from '@/constants/theme';
import { parseEpubBytes } from '@/lib/epub/parseEpub';
import { libraryRepository } from '@/lib/storage/libraryRepository';
import { sampleEpubBytes } from '@/testing/e2eEpub';
import type { LibraryBook } from '@/types/reader';

const E2E_ENABLED = process.env.EXPO_PUBLIC_E2E === '1';

export default function LibraryScreen() {
  const router = useRouter();
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setBooks(await libraryRepository.list());
  }, []);

  useFocusEffect(useCallback(() => {
    void reload();
  }, [reload]));

  const saveImportedBook = useCallback(async (data: ArrayBuffer | Uint8Array, name: string) => {
    setError(null);
    setIsImporting(true);
    try {
      const book = await parseEpubBytes(data, name);
      await libraryRepository.saveBook(book);
      await reload();
      router.push(`/reader/${book.id}` as Href);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The book could not be imported');
    } finally {
      setIsImporting(false);
    }
  }, [reload, router]);

  const importBook = useCallback(async () => {
    setError(null);
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/epub+zip', 'application/zip'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    await saveImportedBook(await new File(asset.uri).arrayBuffer(), asset.name);
  }, [saveImportedBook]);

  const importE2eBook = useCallback(async () => {
    return saveImportedBook(await sampleEpubBytes(), 'sample.epub');
  }, [saveImportedBook]);

  const confirmDelete = useCallback((book: LibraryBook) => {
    Alert.alert('Remove book?', `${book.title} will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => void libraryRepository.removeBook(book.id).then(reload),
      },
    ]);
  }, [reload]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>NARRATOR</Text>
          <Text style={styles.title}>Your library</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Import EPUB"
          disabled={isImporting}
          onPress={importBook}
          style={({ pressed }) => [styles.importButton, pressed && styles.pressed]}
          testID="import-epub-button"
        >
          {isImporting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.importLabel}>＋ EPUB</Text>}
        </Pressable>
      </View>

      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

      {E2E_ENABLED ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Import bundled E2E EPUB"
          disabled={isImporting}
          onPress={() => void importE2eBook()}
          style={styles.e2eButton}
          testID="import-e2e-epub-button"
        >
          <Text style={styles.e2eButtonLabel}>Import test EPUB</Text>
        </Pressable>
      ) : null}

      <FlatList
        contentContainerStyle={books.length === 0 ? styles.emptyList : styles.bookList}
        data={books}
        keyExtractor={(book) => book.id}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyMark}>Aa</Text>
            <Text style={styles.emptyTitle}>Bring your books with you</Text>
            <Text style={styles.emptyBody}>Import an EPUB to read and listen offline with Sky v3.</Text>
            <Pressable onPress={importBook} style={styles.emptyButton}>
              <Text style={styles.emptyButtonLabel}>Choose an EPUB</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.title} by ${item.author}`}
            onLongPress={() => confirmDelete(item)}
            onPress={() => router.push(`/reader/${item.id}` as Href)}
            style={({ pressed }) => [styles.bookCard, pressed && styles.pressed]}
            testID={`book-${item.id}`}
          >
            {item.cover ? (
              <Image accessibilityIgnoresInvertColors source={{ uri: item.cover }} style={styles.cover} />
            ) : (
              <View style={styles.coverFallback}><Text style={styles.coverLetter}>{item.title.slice(0, 1)}</Text></View>
            )}
            <View style={styles.bookDetails}>
              <Text numberOfLines={2} style={styles.bookTitle}>{item.title}</Text>
              <Text numberOfLines={1} style={styles.author}>{item.author}</Text>
              <Text style={styles.chapterCount}>{item.chapterCount} chapters</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.canvas, flex: 1 },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', padding: 22 },
  eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '900', letterSpacing: 2.4 },
  title: { color: colors.ink, fontFamily: 'Georgia', fontSize: 32, fontWeight: '700', marginTop: 3 },
  importButton: { backgroundColor: colors.accent, borderRadius: 18, minWidth: 86, paddingHorizontal: 14, paddingVertical: 10 },
  importLabel: { color: colors.white, fontSize: 13, fontWeight: '800', textAlign: 'center' },
  error: { color: colors.danger, marginHorizontal: 22, marginBottom: 10 },
  e2eButton: { alignSelf: 'center', borderColor: colors.accent, borderRadius: 14, borderWidth: 1, marginBottom: 12, paddingHorizontal: 14, paddingVertical: 8 },
  e2eButtonLabel: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  bookList: { gap: 12, paddingHorizontal: 18, paddingBottom: 30 },
  emptyList: { flexGrow: 1, justifyContent: 'center', padding: 32 },
  emptyState: { alignItems: 'center' },
  emptyMark: { color: colors.accent, fontFamily: 'Georgia', fontSize: 72, fontStyle: 'italic' },
  emptyTitle: { color: colors.ink, fontFamily: 'Georgia', fontSize: 25, fontWeight: '700', marginTop: 14 },
  emptyBody: { color: colors.muted, fontSize: 16, lineHeight: 24, marginTop: 10, maxWidth: 300, textAlign: 'center' },
  emptyButton: { borderColor: colors.accent, borderRadius: 22, borderWidth: 1, marginTop: 24, paddingHorizontal: 22, paddingVertical: 12 },
  emptyButtonLabel: { color: colors.accent, fontWeight: '800' },
  bookCard: { alignItems: 'center', backgroundColor: colors.paper, borderColor: colors.border, borderRadius: 14, borderWidth: 1, flexDirection: 'row', padding: 12 },
  cover: { borderRadius: 6, height: 94, width: 64 },
  coverFallback: { alignItems: 'center', backgroundColor: colors.ink, borderRadius: 6, height: 94, justifyContent: 'center', width: 64 },
  coverLetter: { color: colors.paper, fontFamily: 'Georgia', fontSize: 34 },
  bookDetails: { flex: 1, marginHorizontal: 14 },
  bookTitle: { color: colors.ink, fontFamily: 'Georgia', fontSize: 19, fontWeight: '700' },
  author: { color: colors.muted, fontSize: 14, marginTop: 6 },
  chapterCount: { color: colors.accent, fontSize: 12, fontWeight: '700', marginTop: 12 },
  chevron: { color: colors.muted, fontSize: 32 },
  pressed: { opacity: 0.7 },
});
