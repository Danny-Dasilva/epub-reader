#!/usr/bin/env node
/**
 * Creates a minimal valid EPUB file for testing purposes.
 * Run: node e2e/fixtures/create-test-epub.mjs
 */
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// EPUB is a ZIP with specific structure. We'll build it manually.
// Using a minimal approach with the node built-in zlib.

import { createWriteStream } from 'fs';

// We'll use a simpler approach: write raw bytes for a minimal ZIP/EPUB
// The proper way needs a zip library, so let's use the archiver approach inline.

async function createEpub() {
  // Dynamic import for built-in modules
  const { Writable } = await import('stream');

  // Minimal EPUB structure as a Map of path -> content
  const files = new Map();

  // mimetype (must be first, uncompressed)
  files.set('mimetype', 'application/epub+zip');

  // META-INF/container.xml
  files.set('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // OEBPS/content.opf
  files.set('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">test-book-001</dc:identifier>
    <dc:title>Test Book for Playwright</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`);

  // Navigation document
  files.set('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Navigation</title></head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol>
      <li><a href="chapter1.xhtml">Chapter 1: The Beginning</a></li>
      <li><a href="chapter2.xhtml">Chapter 2: The Middle</a></li>
      <li><a href="chapter3.xhtml">Chapter 3: The End</a></li>
    </ol>
  </nav>
</body>
</html>`);

  // Chapter 1 - multiple paragraphs for sentence testing
  files.set('OEBPS/chapter1.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1: The Beginning</h1>
  <p>This is the first sentence of the test book. It contains multiple words for highlighting tests. The quick brown fox jumps over the lazy dog.</p>
  <p>Here is a second paragraph with <b>bold text</b> and <i>italic text</i> for formatting tests. This sentence has some interesting punctuation! Does the question mark work correctly?</p>
  <p>The third paragraph has longer content. It is designed to test the sentence tokenizer thoroughly. Each sentence should be detected properly. Short ones too. And this final sentence wraps up chapter one with enough words to verify word-level highlighting across multiple syllables and phonemes.</p>
</body>
</html>`);

  // Chapter 2 - for chapter navigation testing
  files.set('OEBPS/chapter2.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
  <h1>Chapter 2: The Middle</h1>
  <p>Welcome to chapter two. This chapter tests navigation between chapters. The reader should be able to move forward and backward.</p>
  <p>A unique phrase for search testing: "elephants dancing in moonlight" cannot be found anywhere else in this book. This makes it perfect for search validation.</p>
  <p>This paragraph contains numbers like 42 and special characters like the em-dash — which should be handled by the text preprocessor. Also testing: semicolons; colons: and ellipsis...</p>
</body>
</html>`);

  // Chapter 3 - for end-of-book testing
  files.set('OEBPS/chapter3.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 3</title></head>
<body>
  <h1>Chapter 3: The End</h1>
  <p>This is the final chapter. It tests what happens at the end of a book. The reader should handle the last sentence gracefully.</p>
  <p>The sleep timer test can use this chapter. When set to "end of chapter" mode, playback should stop after this chapter finishes playing completely.</p>
  <p>And now we reach the very last sentence of the entire test book.</p>
</body>
</html>`);

  // Build ZIP manually using Node.js zlib
  const { createDeflateRaw } = await import('zlib');
  const { promisify } = await import('util');

  // Simple ZIP builder
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
    return new Promise((resolve, reject) => {
      const chunks = [];
      const deflater = createDeflateRaw();
      deflater.on('data', (chunk) => chunks.push(chunk));
      deflater.on('end', () => resolve(Buffer.concat(chunks)));
      deflater.on('error', reject);
      deflater.end(buf);
    });
  }

  for (const [path, content] of files) {
    const data = Buffer.from(content, 'utf-8');
    const crc = crc32(data);
    const isMimetype = path === 'mimetype';

    // For mimetype, store uncompressed (EPUB spec requirement)
    const compressed = isMimetype ? data : await deflate(data);
    const method = isMimetype ? 0 : 8;

    const nameBuffer = Buffer.from(path, 'utf-8');

    // Local file header
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8); // compression method
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14); // crc32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length
    nameBuffer.copy(local, 30);

    entries.push(local, compressed);

    // Central directory entry
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10); // compression method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16); // crc32
    central.writeUInt32LE(compressed.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuffer.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // relative offset
    nameBuffer.copy(central, 46);

    centralDir.push(central);
    offset += local.length + compressed.length;
  }

  // End of central directory
  const centralDirBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.size, 8); // entries on disk
  eocd.writeUInt16LE(files.size, 10); // total entries
  eocd.writeUInt32LE(centralDirBuf.length, 12); // central dir size
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  const epub = Buffer.concat([...entries, centralDirBuf, eocd]);
  const outPath = resolve(__dirname, 'sample.epub');
  writeFileSync(outPath, epub);
  console.log(`Created test EPUB: ${outPath} (${epub.length} bytes)`);
}

createEpub().catch(console.error);
