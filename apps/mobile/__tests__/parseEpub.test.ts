import JSZip from 'jszip';

import { parseEpubBytes } from '@/lib/epub/parseEpub';
import { sampleEpubBytes } from '@/testing/e2eEpub';

async function createEpub(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', `
    <container><rootfiles><rootfile full-path="OPS/package.opf" /></rootfiles></container>
  `);
  zip.file('OPS/package.opf', `
    <package xmlns:dc="http://purl.org/dc/elements/1.1/">
      <metadata><dc:title>Native Reader</dc:title><dc:creator>Danny</dc:creator><dc:identifier>native-reader</dc:identifier></metadata>
      <manifest><item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml" /></manifest>
      <spine><itemref idref="chapter" /></spine>
    </package>
  `);
  zip.file('OPS/text/chapter.xhtml', '<html><body><h1>Opening</h1><p>Hello world. Keep reading!</p></body></html>');
  return zip.generateAsync({ type: 'uint8array' });
}

describe('parseEpubBytes', () => {
  it('parses metadata, spine order, chapters, and sentences without DOM APIs', async () => {
    const book = await parseEpubBytes(await createEpub(), 'reader.epub');
    expect(book.title).toBe('Native Reader');
    expect(book.author).toBe('Danny');
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].sentences.map((sentence) => sentence.text)).toEqual([
      'Opening',
      'Hello world.',
      'Keep reading!',
    ]);
  });

  it('rejects archives that are not EPUB containers', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'not an epub');
    await expect(parseEpubBytes(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      'META-INF/container.xml',
    );
  });

  it('parses the exact EPUB fixture used by the device E2E flow', async () => {
    const book = await parseEpubBytes(await sampleEpubBytes(), 'sample.epub');
    expect(book.title).toBe('Narrator E2E Book');
    expect(book.author).toBe('Expo Test Author');
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].sentences[1].text).toBe(
      'This is the first narrated sentence in the Expo test book.',
    );
  });
});
