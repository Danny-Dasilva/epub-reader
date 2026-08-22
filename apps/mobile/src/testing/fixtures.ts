import type { ReaderBook } from '@/types/reader';

export const TEST_BOOK: ReaderBook = {
  id: 'book-test',
  title: 'Test Book',
  author: 'Test Author',
  cover: null,
  importedAt: 1,
  chapters: [
    {
      id: 'chapter-0',
      href: 'chapter-1.xhtml',
      title: 'First chapter',
      plainText: 'One two three. Four five.',
      sentences: [
        { id: 'sentence-0', text: 'One two three.', chapterId: 'chapter-0', startIndex: 0, endIndex: 14 },
        { id: 'sentence-1', text: 'Four five.', chapterId: 'chapter-0', startIndex: 15, endIndex: 25 },
      ],
    },
    {
      id: 'chapter-1',
      href: 'chapter-2.xhtml',
      title: 'Second chapter',
      plainText: 'Six seven.',
      sentences: [
        { id: 'sentence-2', text: 'Six seven.', chapterId: 'chapter-1', startIndex: 0, endIndex: 10 },
      ],
    },
  ],
};
