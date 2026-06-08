#!/usr/bin/env node
/**
 * Creates a minimal valid EPUB containing an INLINE RASTER IMAGE for testing
 * the reader's inline-image rendering feature.
 *
 * Adapted from create-test-epub.mjs. Key differences:
 *  - Adds an `OEBPS/images/red.png` manifest item (a tiny valid 4x4 PNG).
 *  - References it with `<img src="images/red.png" alt="A red square"/>`
 *    placed BETWEEN two paragraphs of chapter 1.
 *  - The ZIP builder now supports BINARY (Buffer) file contents (the PNG),
 *    in addition to UTF-8 strings.
 *  - Distinct title/author so its bookId differs from sample.epub.
 *  - The package (content.opf) lives at the ARCHIVE ROOT (not under OEBPS/).
 *
 * Sentence layout once parsed (verified): the <h1> yields sentences 0 and 1,
 * paragraph 1 yields sentences 2, 3, 4, the inline image is anchored before the
 * first sentence of paragraph 2, and paragraph 2 yields sentences 5, 6, 7. So
 * the <figure class="block-image"> must render between sentence-4 and sentence-5.
 *
 * Run: node e2e/fixtures/create-image-epub.mjs
 */
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A tiny but valid 4x4 truecolor red PNG (generated with zlib, verified decodable).
const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==';

async function createEpub() {
  // path -> { content: string|Buffer }
  const files = new Map();

  // mimetype (must be first, uncompressed)
  files.set('mimetype', 'application/epub+zip');

  files.set('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  files.set('content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">test-image-book-001</dc:identifier>
    <dc:title>Inline Image Test Book</dc:title>
    <dc:creator>Image Test Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-02-02T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="redimg" href="images/red.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`);

  files.set('nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Navigation</title></head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol>
      <li><a href="chapter1.xhtml">Chapter 1: Pictures</a></li>
    </ol>
  </nav>
</body>
</html>`);

  // Chapter 1: two paragraphs of sentences with an inline image BETWEEN them.
  // The image is anchored before the first sentence of the second paragraph.
  files.set('chapter1.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1: Pictures</h1>
  <p>This is the first sentence before the image. Here is a second sentence with more words to tokenize. The quick brown fox jumps over the lazy dog before we reach the picture.</p>
  <p><img src="images/red.png" alt="A red square"/></p>
  <p>This is the first sentence after the image. Here is another sentence following the picture for good measure. The lazy dog finally wakes up after the fox has gone away.</p>
</body>
</html>`);

  // The raster image itself.
  files.set('images/red.png', Buffer.from(RED_PNG_BASE64, 'base64'));

  // ---- ZIP builder (supports string and Buffer content) ----
  const { createDeflateRaw } = await import('zlib');

  const entries = [];
  const centralDir = [];
  let offset = 0;

  function crc32(buf) {
    const data = typeof buf === 'string' ? Buffer.from(buf, 'utf-8') : buf;
    let crc = 0xFFFFFFFF;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async function deflate(buf) {
    return new Promise((resolveP, reject) => {
      const chunks = [];
      const deflater = createDeflateRaw();
      deflater.on('data', (chunk) => chunks.push(chunk));
      deflater.on('end', () => resolveP(Buffer.concat(chunks)));
      deflater.on('error', reject);
      deflater.end(buf);
    });
  }

  for (const [path, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
    const crc = crc32(data);
    const isMimetype = path === 'mimetype';

    const compressed = isMimetype ? data : await deflate(data);
    const method = isMimetype ? 0 : 8;

    const nameBuffer = Buffer.from(path, 'utf-8');

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);

    entries.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);

    centralDir.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const epub = Buffer.concat([...entries, centralDirBuf, eocd]);
  const outPath = resolve(__dirname, 'sample-image.epub');
  writeFileSync(outPath, epub);
  console.log(`Created image EPUB: ${outPath} (${epub.length} bytes)`);
}

createEpub().catch(console.error);
