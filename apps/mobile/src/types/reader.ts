export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface ReaderSentence {
  id: string;
  text: string;
  chapterId: string;
  startIndex: number;
  endIndex: number;
}

export interface ReaderChapter {
  id: string;
  href: string;
  title: string;
  plainText: string;
  sentences: ReaderSentence[];
}

export interface ReaderBook {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  chapters: ReaderChapter[];
  importedAt: number;
}

export interface LibraryBook {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  chapterCount: number;
  importedAt: number;
}

export interface ReaderPosition {
  chapterIndex: number;
  sentenceIndex: number;
}

export interface SynthesizedAudio {
  uri: string;
  duration: number;
  wordTimings: WordTiming[];
}
