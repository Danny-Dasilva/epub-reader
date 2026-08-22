import { htmlToPlainText, sentenceTokenize, titleFromChapter } from '@/lib/epub/text';

describe('EPUB text extraction', () => {
  it('removes non-readable markup and preserves block boundaries', () => {
    const text = htmlToPlainText(`
      <html><body>
        <h1>Chapter One</h1>
        <script>doNotRead()</script>
        <p>Hello <em>mobile</em> reader.</p>
        <p>Second paragraph &amp; more.</p>
      </body></html>
    `);
    expect(text).toBe('Chapter One\n\nHello mobile reader.\n\nSecond paragraph & more.');
    expect(text).not.toContain('doNotRead');
  });

  it('creates stable sentence identifiers and source offsets', () => {
    const text = 'First sentence. Second one!\n\nA final question?';
    const sentences = sentenceTokenize(text, 'chapter-2');
    expect(sentences.map((sentence) => sentence.id)).toEqual([
      'chapter-2-sentence-0',
      'chapter-2-sentence-1',
      'chapter-2-sentence-2',
    ]);
    expect(text.slice(sentences[1].startIndex, sentences[1].endIndex)).toBe('Second one!');
  });

  it('uses a short opening line as the chapter title', () => {
    expect(titleFromChapter('A New Beginning\n\nBody copy.', 'Chapter 4')).toBe('A New Beginning');
  });
});
