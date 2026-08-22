import { phonemize as espeakPhonemize } from 'phonemizer';

const CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/gu;
const WHITESPACE_PATTERN = /\s+/gu;
const PUNCTUATION_PATTERN = /(\s*[;:,.!?¡¿—…"«»“”()[\]{}]+\s*)+/gu;
const DECIMAL_POINT_PATTERN = /(?<=\d)\.(?=\d)/gu;
const DECIMAL_SENTINEL = '\uE000';
const BOUNDARY_PAUSES = new Map([
  ['?', 0.28], ['？', 0.28], ['!', 0.24], ['！', 0.24],
  ['.', 0.22], ['。', 0.22], [';', 0.16], ['；', 0.16],
  [':', 0.13], ['：', 0.13], [',', 0.09], ['，', 0.09],
]);

export interface InflectSymbolInventory {
  count: number;
  format: string;
  symbols: string[];
}

export function normalizeInflectText(text: string): string {
  if (typeof text !== 'string') {
    throw new Error('Text input must be a string');
  }
  if (text.includes('\0')) {
    throw new Error('Text input contains a null byte');
  }

  const normalized = text
    .normalize('NFKC')
    .replace(/[\r\n\t]/gu, ' ')
    .replace(CONTROL_OR_FORMAT_PATTERN, '')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();

  if (!normalized) {
    throw new Error('Text input is empty after normalization');
  }
  return normalized;
}

function splitWithPunctuation(text: string): Array<{ punctuation: boolean; value: string }> {
  const protectedText = text.replace(DECIMAL_POINT_PATTERN, DECIMAL_SENTINEL);
  const sections: Array<{ punctuation: boolean; value: string }> = [];
  let previousIndex = 0;

  for (const match of protectedText.matchAll(PUNCTUATION_PATTERN)) {
    const index = match.index;
    if (index > previousIndex) {
      sections.push({
        punctuation: false,
        value: protectedText.slice(previousIndex, index).replaceAll(DECIMAL_SENTINEL, '.'),
      });
    }
    sections.push({
      punctuation: true,
      value: match[0].replaceAll(DECIMAL_SENTINEL, '.'),
    });
    previousIndex = index + match[0].length;
  }

  if (previousIndex < protectedText.length) {
    sections.push({
      punctuation: false,
      value: protectedText.slice(previousIndex).replaceAll(DECIMAL_SENTINEL, '.'),
    });
  }
  return sections;
}

/**
 * Match the export's eSpeak frontend while preserving punctuation. The browser
 * phonemizer deliberately omits punctuation, so punctuation spans are kept out
 * of eSpeak and joined back into the IPA output afterward.
 */
export async function phonemizeInflectText(text: string, language = 'en-us'): Promise<string> {
  const normalized = normalizeInflectText(text);
  const sections = splitWithPunctuation(normalized);
  const converted = await Promise.all(
    sections.map(async ({ punctuation, value }) => {
      if (punctuation) return value;
      if (!value.trim()) return value;
      return (await espeakPhonemize(value, language)).join(' ');
    }),
  );

  return converted.join('').normalize('NFC').replace(WHITESPACE_PATTERN, ' ').trim();
}

export function phonemesToTokenIds(
  phonemes: string,
  inventory: InflectSymbolInventory,
  addBlank: boolean,
): BigInt64Array {
  const symbolIds = new Map<string, number>();
  // The published inventory intentionally contains a duplicate apostrophe.
  // Python list.index() resolves duplicates to their first occurrence.
  for (let index = 0; index < inventory.symbols.length; index++) {
    if (!symbolIds.has(inventory.symbols[index])) {
      symbolIds.set(inventory.symbols[index], index);
    }
  }

  const rawIds: number[] = [];
  const unknown = new Set<string>();
  for (const symbol of phonemes) {
    const id = symbolIds.get(symbol);
    if (id === undefined) {
      unknown.add(symbol);
    } else {
      rawIds.push(id);
    }
  }

  if (unknown.size > 0) {
    console.warn('[Inflect] Dropped symbols absent from the Sky v3 inventory:', [...unknown]);
  }
  if (rawIds.length === 0) {
    throw new Error('The Inflect frontend produced no speakable tokens');
  }

  const ids = addBlank ? new Array<number>(rawIds.length * 2 + 1).fill(0) : rawIds;
  if (addBlank) {
    for (let index = 0; index < rawIds.length; index++) {
      ids[index * 2 + 1] = rawIds[index];
    }
  }
  return BigInt64Array.from(ids, BigInt);
}

export function splitInflectText(text: string, limit = 280): string[] {
  const normalized = normalizeInflectText(text);
  const sentences = normalized
    .split(/(?<=[.!?;:。！？；：])\s*/gu)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];

  for (let sentence of sentences.length > 0 ? sentences : [normalized]) {
    while (sentence.length > limit) {
      const search = sentence.slice(0, limit + 1);
      const punctuation = Math.max(...[',', ';', ':', '，', '；', '：'].map((mark) => search.lastIndexOf(mark)));
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
  const ending = text.trim().slice(-1);
  return BOUNDARY_PAUSES.get(ending) ?? 0.08;
}

export function applyEdgeFade(waveform: Float32Array, sampleRate: number, milliseconds = 5): void {
  const frames = Math.min(Math.round(sampleRate * milliseconds / 1000), Math.floor(waveform.length / 2));
  if (frames <= 0) return;

  for (let index = 0; index < frames; index++) {
    const gain = frames === 1 ? 1 : index / (frames - 1);
    waveform[index] *= gain;
    waveform[waveform.length - index - 1] *= gain;
  }
}
