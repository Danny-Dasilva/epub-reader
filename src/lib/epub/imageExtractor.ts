/**
 * Inline-image extraction for EPUB chapters.
 *
 * Images embedded in chapter XHTML (<img src> / SVG <image xlink:href>) are
 * referenced by relative paths that resolve, via the EPUB package, to entries
 * inside the zip archive. To display them on the web we extract the bytes from
 * the archive and produce data: URLs.
 *
 * Data URLs (rather than object URLs) are used deliberately:
 *  - They serialize cleanly through the existing JSON + gzip IndexedDB cache
 *    (see bookStorage.ts), so images survive a reload with no extra blob store
 *    and no object-URL lifecycle/revocation to manage.
 *  - The cover image already uses the same data-URL strategy.
 *
 * Images are display-only and never sent to TTS. See ChapterImage.
 */

import type { Book } from 'epubjs';
import { ChapterImage, Sentence } from './types';
import { RawImageRef } from './formattingExtractor';

/**
 * Map a raw image reference's character position to the index of the sentence
 * it should be rendered BEFORE. Sentences are sorted by startIndex, so the
 * first sentence starting at/after the image's char position is the anchor.
 * Images past the last sentence map to sentences.length (render at the end).
 */
export function imageSentenceIndex(charIndex: number, sentences: Sentence[]): number {
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].startIndex >= charIndex) {
      return i;
    }
  }
  return sentences.length;
}

/**
 * Resolve and load inline images for a chapter into ChapterImage entries with
 * data: URLs. `sentences` must already include any title-prefix offset so the
 * mapping to sentence indices is correct. `rawImages` charIndex values must be
 * in the same coordinate space (caller applies the title offset).
 *
 * Failures to load an individual image are logged and skipped (the rest of the
 * chapter still renders).
 */
export async function resolveChapterImages(
  book: Book,
  chapterHref: string,
  chapterId: string,
  rawImages: RawImageRef[],
  sentences: Sentence[]
): Promise<ChapterImage[]> {
  if (rawImages.length === 0) return [];

  // Cache per-href so a repeated image in one chapter is only fetched once.
  const dataUrlCache = new Map<string, string | null>();

  const results: ChapterImage[] = [];

  for (let i = 0; i < rawImages.length; i++) {
    const raw = rawImages[i];
    let dataUrl = dataUrlCache.get(raw.href);

    if (dataUrl === undefined) {
      dataUrl = await loadImageDataUrl(book, chapterHref, raw.href);
      dataUrlCache.set(raw.href, dataUrl);
    }

    if (!dataUrl) continue;

    results.push({
      id: `${chapterId}-img${i}`,
      src: dataUrl,
      alt: raw.alt,
      sentenceIndex: imageSentenceIndex(raw.charIndex, sentences)
    });
  }

  return results;
}

/**
 * Load a single image from the EPUB archive and return a data: URL, or null on
 * failure / unsupported source.
 */
async function loadImageDataUrl(
  book: Book,
  chapterHref: string,
  href: string
): Promise<string | null> {
  // Pass through already-inlined data URIs.
  if (href.startsWith('data:')) return href;

  // Remote/absolute URLs are not in the archive — leave them as-is so the
  // browser can attempt to load them (rare in EPUBs, but harmless).
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
    return href;
  }

  try {
    // Resolve the chapter-relative href against the chapter's location to get
    // the archive-absolute path (WITH a leading slash), then read the bytes
    // from the zip.
    //
    // epub.js's Archive.getBase64/getBlob/getText (and Resources.createUrl,
    // which delegates to them) all do `url.substr(1)` internally — they expect
    // an archive-absolute path WITH a leading slash and strip exactly that one
    // character. So we must pass the leading-slash form that `book.resolve`
    // produces; stripping it ourselves would make epub.js eat the first real
    // character of the path ("/images/red.png" -> "mages/red.png" -> not found).
    const resolved = resolveAgainstChapter(book, chapterHref, href);

    const archive = book.archive as
      | { getBase64?: (url: string, mimeType?: string) => Promise<string> }
      | undefined;

    if (archive?.getBase64) {
      // getBase64 returns a full data: URL string in epub.js.
      const base64 = await archive.getBase64(resolved);
      if (base64) return base64;
    }

    // Fallback: use resources.createUrl if archive access failed.
    const resources = book.resources as
      | { createUrl?: (url: string) => Promise<string> }
      | undefined;
    if (resources?.createUrl) {
      const url = await resources.createUrl(resolved);
      if (url) return url;
    }
  } catch (e) {
    console.warn(`Failed to load inline image "${href}":`, e);
  }

  return null;
}

/**
 * Resolve an image href relative to its chapter's href into the archive-absolute
 * path (WITH a leading slash) that epub.js's Archive/Resources methods expect.
 *
 * Those methods do `url.substr(1)` internally, so the leading slash is required
 * and intentional — see loadImageDataUrl for the full rationale.
 */
function resolveAgainstChapter(book: Book, chapterHref: string, href: string): string {
  // Absolute archive path already — make sure it has exactly one leading slash.
  if (href.startsWith('/')) {
    return ensureLeadingSlash(normalizePath(href));
  }

  // epub.js Book.resolve resolves against the package (OPF) root. Chapter hrefs
  // and image hrefs in the manifest are typically expressed relative to the OPF,
  // but inline img@src is relative to the *chapter file*. So join against the
  // chapter's directory first, then resolve.
  const chapterDir = chapterHref.includes('/')
    ? chapterHref.slice(0, chapterHref.lastIndexOf('/') + 1)
    : '';
  const joined = normalizePath(chapterDir + href);

  const resolve = (book as unknown as { resolve?: (p: string, absolute?: boolean) => string }).resolve;
  if (typeof resolve === 'function') {
    try {
      // absolute=false keeps it archive-relative (no http origin), but epub.js
      // still returns a leading-slash, archive-absolute path — which is exactly
      // what getBase64/getBlob/createUrl want (they strip the slash via substr).
      const r = resolve.call(book, joined, false);
      if (r) return ensureLeadingSlash(r);
    } catch {
      // fall through to manual join
    }
  }

  return ensureLeadingSlash(joined);
}

/** Collapse ./ and ../ segments in a path. */
function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/');
  const parts = path.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return (isAbsolute ? '/' : '') + out.join('/');
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith('/') ? p : '/' + p;
}
