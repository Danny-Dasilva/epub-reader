import JSZip from 'jszip';

export async function sampleEpubBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `
    <container><rootfiles><rootfile full-path="OEBPS/content.opf" /></rootfiles></container>
  `);
  zip.file('OEBPS/content.opf', `
    <package xmlns:dc="http://purl.org/dc/elements/1.1/">
      <metadata>
        <dc:title>Narrator E2E Book</dc:title>
        <dc:creator>Expo Test Author</dc:creator>
        <dc:identifier>narrator-expo-e2e</dc:identifier>
      </metadata>
      <manifest>
        <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml" />
        <item id="chapter-2" href="chapter-2.xhtml" media-type="application/xhtml+xml" />
      </manifest>
      <spine>
        <itemref idref="chapter-1" />
        <itemref idref="chapter-2" />
      </spine>
    </package>
  `);
  zip.file('OEBPS/chapter-1.xhtml', `
    <html><body>
      <h1>Opening</h1>
      <p>This is the first narrated sentence in the Expo test book.</p>
      <p>The second sentence verifies skipping and word highlighting.</p>
      <p>A final sentence makes previous navigation testable.</p>
    </body></html>
  `);
  zip.file('OEBPS/chapter-2.xhtml', `
    <html><body>
      <h1>Second chapter</h1>
      <p>Chapter navigation keeps the current line highlighted.</p>
    </body></html>
  `);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
