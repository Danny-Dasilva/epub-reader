import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

import type { ReaderBook, ReaderChapter } from '@/types/reader';
import { htmlToPlainText, sentenceTokenize, titleFromChapter } from './text';

interface ManifestItem {
  '@_id': string;
  '@_href': string;
  '@_media-type'?: string;
  '@_properties'?: string;
}

interface SpineItem {
  '@_idref': string;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return textValue(value[0], fallback);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return textValue(object['#text'] ?? object['text'], fallback);
  }
  return fallback;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function resolvePath(baseFile: string, relative: string): string {
  return normalizePath(`${dirname(baseFile)}${decodeURIComponent(relative.split('#')[0])}`);
}

function stableId(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `book-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function extractCover(
  zip: JSZip,
  packagePath: string,
  metadata: Record<string, unknown>,
  manifest: ManifestItem[],
): Promise<string | null> {
  const metas = asArray(metadata.meta as Record<string, unknown> | Record<string, unknown>[]);
  const legacyCoverId = metas.find((meta) => meta['@_name'] === 'cover')?.['@_content'];
  const coverItem = manifest.find((item) =>
    item['@_properties']?.split(/\s+/u).includes('cover-image') || item['@_id'] === legacyCoverId,
  );
  if (!coverItem) return Promise.resolve(null);

  const entry = zip.file(resolvePath(packagePath, coverItem['@_href']));
  if (!entry) return Promise.resolve(null);
  const mime = coverItem['@_media-type'] || 'image/jpeg';
  return entry.async('base64').then((content) => `data:${mime};base64,${content}`);
}

export async function parseEpubBytes(
  data: ArrayBuffer | Uint8Array,
  sourceName = 'Imported book.epub',
): Promise<ReaderBook> {
  const zip = await JSZip.loadAsync(data);
  const containerText = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerText) throw new Error('This EPUB is missing META-INF/container.xml');

  const container = xml.parse(containerText) as Record<string, any>;
  const rootfiles = asArray(container.container?.rootfiles?.rootfile);
  const packagePath = rootfiles[0]?.['@_full-path'] as string | undefined;
  if (!packagePath) throw new Error('The EPUB container does not reference a package document');

  const packageText = await zip.file(normalizePath(packagePath))?.async('text');
  if (!packageText) throw new Error(`The EPUB package document is missing: ${packagePath}`);

  const packageDocument = xml.parse(packageText) as Record<string, any>;
  const epubPackage = packageDocument.package;
  if (!epubPackage) throw new Error('The EPUB package document is invalid');

  const metadata = (epubPackage.metadata ?? {}) as Record<string, unknown>;
  const title = textValue(metadata.title, sourceName.replace(/\.epub$/iu, ''));
  const author = textValue(metadata.creator, 'Unknown author');
  const identifier = textValue(metadata.identifier, `${title}:${author}:${sourceName}`);
  const manifest = asArray<ManifestItem>(epubPackage.manifest?.item);
  const manifestById = new Map(manifest.map((item) => [item['@_id'], item]));
  const spine = asArray<SpineItem>(epubPackage.spine?.itemref);
  const chapters: ReaderChapter[] = [];

  for (const spineItem of spine) {
    const item = manifestById.get(spineItem['@_idref']);
    if (!item || !/xhtml|html/iu.test(item['@_media-type'] ?? '')) continue;

    const href = resolvePath(packagePath, item['@_href']);
    const chapterHtml = await zip.file(href)?.async('text');
    if (!chapterHtml) continue;
    const plainText = htmlToPlainText(chapterHtml);
    if (!plainText) continue;

    const chapterIndex = chapters.length;
    const chapterId = `chapter-${chapterIndex}`;
    const fallbackTitle = `Chapter ${chapterIndex + 1}`;
    chapters.push({
      id: chapterId,
      href,
      title: titleFromChapter(plainText, fallbackTitle),
      plainText,
      sentences: sentenceTokenize(plainText, chapterId),
    });
  }

  if (chapters.length === 0) throw new Error('No readable chapters were found in this EPUB');

  return {
    id: stableId(identifier),
    title,
    author,
    cover: await extractCover(zip, packagePath, metadata, manifest),
    chapters,
    importedAt: Date.now(),
  };
}
