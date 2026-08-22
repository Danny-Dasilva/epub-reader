import { decodeHTML } from 'entities';

import type { ReaderSentence } from '@/types/reader';

const INVISIBLE_CONTENT = /<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/giu;
const BLOCK_TAG = /<\/?(?:address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>/giu;
const LINE_BREAK = /<br\s*\/?>/giu;
const TAG = /<[^>]+>/gu;
const COMMENT = /<!--[\s\S]*?-->/gu;
const SENTENCE = /[^.!?]+(?:[.!?]+["'”’)]*|$)/gu;

export function htmlToPlainText(html: string): string {
  const decoded = decodeHTML(
    html
      .replace(COMMENT, ' ')
      .replace(INVISIBLE_CONTENT, ' ')
      .replace(LINE_BREAK, '\n')
      .replace(BLOCK_TAG, '\n')
      .replace(TAG, ' '),
  );

  return decoded
    .split(/\n+/gu)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function sentenceTokenize(plainText: string, chapterId: string): ReaderSentence[] {
  const sentences: ReaderSentence[] = [];
  let cursor = 0;

  for (const paragraph of plainText.split(/\n{2,}/gu)) {
    for (const match of paragraph.matchAll(SENTENCE)) {
      const text = match[0].trim();
      if (!text) continue;

      const startIndex = plainText.indexOf(text, cursor);
      const safeStart = startIndex >= 0 ? startIndex : cursor;
      const index = sentences.length;
      sentences.push({
        id: `${chapterId}-sentence-${index}`,
        text,
        chapterId,
        startIndex: safeStart,
        endIndex: safeStart + text.length,
      });
      cursor = safeStart + text.length;
    }
  }

  if (sentences.length === 0 && plainText) {
    sentences.push({
      id: `${chapterId}-sentence-0`,
      text: plainText,
      chapterId,
      startIndex: 0,
      endIndex: plainText.length,
    });
  }
  return sentences;
}

export function titleFromChapter(text: string, fallback: string): string {
  const firstLine = text.split(/\n+/u).find(Boolean)?.trim();
  if (!firstLine || firstLine.length > 90) return fallback;
  return firstLine.replace(/[.!?:;]+$/u, '').trim() || fallback;
}
