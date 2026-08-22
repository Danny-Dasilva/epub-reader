import {
  normalizeInflectText,
  phonemesToTokenIds,
  phonemizeInflectText,
  splitInflectText,
} from '@/lib/tts/inflectFrontend';

describe('Sky v3 mobile frontend', () => {
  it('normalizes Unicode, whitespace, and invisible controls', () => {
    expect(normalizeInflectText('  Ｈello\n\tworld\u200B  ')).toBe('Hello world');
    expect(() => normalizeInflectText('\0')).toThrow('null byte');
  });

  it('phonemizes US English while retaining sentence punctuation', () => {
    const ipa = phonemizeInflectText('Hello world.');
    expect(ipa).toContain('hə');
    expect(ipa.endsWith('.')).toBe(true);
  });

  it('maps duplicate symbols to their first inventory entry and inserts blanks', () => {
    const inventory = { count: 4, format: 'ipa', symbols: ['_', 'h', "'", "'"] };
    expect([...phonemesToTokenIds("'h", inventory, false)]).toEqual([2n, 1n]);
    expect([...phonemesToTokenIds('h', inventory, true)]).toEqual([0n, 1n, 0n]);
  });

  it('chunks long text only at safe spoken boundaries', () => {
    const chunks = splitInflectText(`${'word '.repeat(70)}, next sentence.`.trim(), 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.join(' ')).toContain('next sentence.');
  });
});
