import { phonemize } from 'phonemize';

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
const WHITESPACE = /\s+/gu;
const BOUNDARY_PAUSES = new Map([
  ['?', 0.28], ['!', 0.24], ['.', 0.22], [';', 0.16], [':', 0.13], [',', 0.09],
]);

export interface InflectSymbolInventory {
  count: number;
  format: string;
  symbols: string[];
}

export function normalizeInflectText(text: string): string {
  if (text.includes('\0')) throw new Error('Text contains a null byte');
  const normalized = text
    .normalize('NFKC')
    .replace(/[\r\n\t]/gu, ' ')
    .replace(CONTROL_OR_FORMAT, '')
    .replace(WHITESPACE, ' ')
    .trim();
  if (!normalized) throw new Error('Text is empty after normalization');
  return normalized;
}

export function phonemizeInflectText(text: string, language = 'en-US'): string {
  return phonemize(normalizeInflectText(text), { language, format: 'ipa' })
    .normalize('NFC')
    .replace(WHITESPACE, ' ')
    .trim();
}

export function phonemesToTokenIds(
  phonemes: string,
  inventory: InflectSymbolInventory,
  addBlank: boolean,
): BigInt64Array {
  const symbolIds = new Map<string, number>();
  inventory.symbols.forEach((symbol, index) => {
    if (!symbolIds.has(symbol)) symbolIds.set(symbol, index);
  });

  const rawIds: number[] = [];
  for (const symbol of phonemes) {
    const id = symbolIds.get(symbol);
    if (id !== undefined) rawIds.push(id);
  }
  if (rawIds.length === 0) throw new Error('Sky v3 produced no speakable tokens');

  if (!addBlank) return BigInt64Array.from(rawIds, BigInt);
  const ids = new Array<number>(rawIds.length * 2 + 1).fill(0);
  rawIds.forEach((id, index) => {
    ids[index * 2 + 1] = id;
  });
  return BigInt64Array.from(ids, BigInt);
}

export function splitInflectText(text: string, limit = 280): string[] {
  const normalized = normalizeInflectText(text);
  const sentences = normalized
    .split(/(?<=[.!?;:])\s*/gu)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];

  for (let sentence of sentences.length > 0 ? sentences : [normalized]) {
    while (sentence.length > limit) {
      const punctuation = Math.max(...[',', ';', ':'].map((mark) => sentence.lastIndexOf(mark, limit)));
      let splitAt = punctuation >= limit / 2 ? punctuation + 1 : sentence.lastIndexOf(' ', limit);
      if (splitAt < limit / 2) splitAt = limit;
      chunks.push(sentence.slice(0, splitAt).trim());
      sentence = sentence.slice(splitAt).trim();
    }
    if (sentence) chunks.push(sentence);
  }
  return chunks;
}

export function boundaryPauseSeconds(text: string): number {
  return BOUNDARY_PAUSES.get(text.trim().slice(-1)) ?? 0.08;
}

export function applyEdgeFade(waveform: Float32Array, sampleRate: number, milliseconds = 5): void {
  const frames = Math.min(Math.round(sampleRate * milliseconds / 1000), Math.floor(waveform.length / 2));
  for (let index = 0; index < frames; index++) {
    const gain = frames === 1 ? 1 : index / (frames - 1);
    waveform[index] *= gain;
    waveform[waveform.length - index - 1] *= gain;
  }
}
