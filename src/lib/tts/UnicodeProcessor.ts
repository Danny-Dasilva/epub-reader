/**
 * Unicode Text Processor for TTS
 * Ported from supertonic/web/helper.js
 */
export class UnicodeProcessor {
  private indexer: number[];

  constructor(indexer: number[]) {
    this.indexer = indexer;
  }

  call(textList: string[]): { textIds: number[][]; textMask: number[][][] } {
    const processedTexts = textList.map(text => this.preprocessText(text));

    const textIdsLengths = processedTexts.map(text => text.length);
    const maxLen = Math.max(...textIdsLengths);

    const textIds = processedTexts.map(text => {
      const row = new Array(maxLen).fill(0);
      for (let j = 0; j < text.length; j++) {
        const codePoint = text.codePointAt(j);
        row[j] = codePoint !== undefined && codePoint < this.indexer.length
          ? this.indexer[codePoint]
          : -1;
      }
      return row;
    });

    const textMask = this.getTextMask(textIdsLengths);
    return { textIds, textMask };
  }

  preprocessText(text: string): string {
    // Normalize text
    text = text.normalize('NFKD');

    // Remove emojis (wide Unicode range)
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
    text = text.replace(emojiPattern, '');

    // Replace various dashes and symbols
    const replacements: Record<string, string> = {
      '–': '-',
      '‑': '-',
      '—': '-',
      '¯': ' ',
      '_': ' ',
      '\u201C': '"',  // left double quote "
      '\u201D': '"',  // right double quote "
      '\u2018': "'",  // left single quote '
      '\u2019': "'",  // right single quote '
      '´': "'",
      '`': "'",
      '[': ' ',
      ']': ' ',
      '|': ' ',
      '/': ' ',
      '#': ' ',
      '→': ' ',
      '←': ' ',
    };
    for (const [k, v] of Object.entries(replacements)) {
      text = text.replaceAll(k, v);
    }

    // Remove combining diacritics
    text = text.replace(/[\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F]/g, '');

    // Remove special symbols
    text = text.replace(/[♥☆♡©\\]/g, '');

    // Replace known expressions
    const exprReplacements: Record<string, string> = {
      '@': ' at ',
      'e.g.,': 'for example, ',
      'i.e.,': 'that is, ',
    };
    for (const [k, v] of Object.entries(exprReplacements)) {
      text = text.replaceAll(k, v);
    }

    // Fix spacing around punctuation
    text = text.replace(/ ,/g, ',');
    text = text.replace(/ \./g, '.');
    text = text.replace(/ !/g, '!');
    text = text.replace(/ \?/g, '?');
    text = text.replace(/ ;/g, ';');
    text = text.replace(/ :/g, ':');
    text = text.replace(/ '/g, "'");

    // Remove duplicate quotes
    while (text.includes('""')) {
      text = text.replace('""', '"');
    }
    while (text.includes("''")) {
      text = text.replace("''", "'");
    }
    while (text.includes('``')) {
      text = text.replace('``', '`');
    }

    // Remove extra spaces
    text = text.replace(/\s+/g, ' ').trim();

    // If text doesn't end with punctuation, add a period
    if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(text)) {
      text += '.';
    }

    return text;
  }

  getTextMask(textIdsLengths: number[]): number[][][] {
    const maxLen = Math.max(...textIdsLengths);
    return this.lengthToMask(textIdsLengths, maxLen);
  }

  lengthToMask(lengths: number[], maxLen: number | null = null): number[][][] {
    const actualMaxLen = maxLen || Math.max(...lengths);
    return lengths.map(len => {
      const row = new Array(actualMaxLen).fill(0.0);
      for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
        row[j] = 1.0;
      }
      return [row];
    });
  }
}
