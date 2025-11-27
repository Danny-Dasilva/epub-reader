'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { parseEpub } from '@/lib/epub';
import { useLibraryStore, StoredBook } from '@/store/libraryStore';

// Icons as inline SVGs
const BookIcon = () => (
  <svg className="icon w-6 h-6" viewBox="0 0 24 24">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);

const UploadIcon = () => (
  <svg className="icon w-8 h-8" viewBox="0 0 24 24">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const TrashIcon = () => (
  <svg className="icon w-4 h-4" viewBox="0 0 24 24">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export default function LibraryPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { books, addBook, removeBook } = useLibraryStore();

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.name.endsWith('.epub')) {
      setError('Please select an EPUB file');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const parsedBook = await parseEpub(arrayBuffer);
      addBook(parsedBook);

      // Store the full book data in sessionStorage for the reader
      sessionStorage.setItem(`book-${parsedBook.id}`, JSON.stringify(parsedBook));

      // Navigate to reader
      router.push(`/reader/${parsedBook.id}`);
    } catch (err) {
      console.error('Failed to parse EPUB:', err);
      setError('Failed to parse EPUB file. Please try another file.');
    } finally {
      setIsLoading(false);
    }
  }, [addBook, router]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const handleBookClick = (book: StoredBook) => {
    router.push(`/reader/${book.id}`);
  };

  const handleDeleteBook = (e: React.MouseEvent, bookId: string) => {
    e.stopPropagation();
    if (confirm('Remove this book from your library?')) {
      removeBook(bookId);
      sessionStorage.removeItem(`book-${bookId}`);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-paper-warm)] paper-texture" data-theme="sepia">
      {/* Header */}
      <header className="border-b border-[var(--color-sepia)] bg-[var(--color-paper)]">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <div className="flex items-center gap-3 animate-fade-in">
            <div className="w-10 h-10 rounded-lg bg-[var(--color-ink)] text-[var(--color-paper)] flex items-center justify-center">
              <BookIcon />
            </div>
            <div>
              <h1 className="text-2xl font-serif font-semibold tracking-tight text-[var(--color-ink)]">
                Narrator
              </h1>
              <p className="text-sm text-[var(--color-ink-muted)]">
                Your personal audiobook reader
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        {/* Upload Section */}
        <section className="mb-16 animate-fade-in animate-fade-in-delay-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".epub"
            onChange={handleInputChange}
            className="hidden"
          />

          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`
              upload-zone cursor-pointer p-12 text-center
              ${isDragging ? 'dragover' : ''}
              ${isLoading ? 'opacity-50 pointer-events-none' : ''}
            `}
          >
            <div className="flex flex-col items-center gap-4">
              <div className={`
                w-16 h-16 rounded-full bg-[var(--color-paper-dark)]
                flex items-center justify-center text-[var(--color-ink-muted)]
                transition-all duration-300
                ${isDragging ? 'scale-110 bg-[var(--color-gold-light)] text-[var(--color-ink)]' : ''}
              `}>
                {isLoading ? (
                  <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <UploadIcon />
                )}
              </div>

              <div>
                <p className="text-lg font-medium text-[var(--color-ink)]">
                  {isDragging ? 'Drop your book here' : 'Add a book to your library'}
                </p>
                <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                  Drag & drop an EPUB file or click to browse
                </p>
              </div>
            </div>
          </div>

          {error && (
            <p className="mt-4 text-center text-red-600 text-sm">
              {error}
            </p>
          )}
        </section>

        {/* Library Grid */}
        {books.length > 0 && (
          <section className="animate-fade-in animate-fade-in-delay-2">
            <h2 className="text-sm font-medium uppercase tracking-wider text-[var(--color-ink-muted)] mb-6">
              Your Library
            </h2>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
              {books
                .sort((a, b) => b.lastReadAt - a.lastReadAt)
                .map((book, index) => (
                  <div
                    key={book.id}
                    onClick={() => handleBookClick(book)}
                    className="group cursor-pointer animate-fade-in"
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    {/* Book Cover */}
                    <div className="book-card mb-3 relative">
                      {book.cover ? (
                        <img
                          src={book.cover}
                          alt={book.title}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center p-4">
                          <span className="font-serif text-center text-sm text-[var(--color-ink-muted)] line-clamp-3">
                            {book.title}
                          </span>
                        </div>
                      )}

                      {/* Progress indicator */}
                      {book.progress > 0 && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20">
                          <div
                            className="h-full bg-[var(--color-gold)]"
                            style={{ width: `${book.progress}%` }}
                          />
                        </div>
                      )}

                      {/* Delete button */}
                      <button
                        onClick={(e) => handleDeleteBook(e, book.id)}
                        className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 text-white
                                   opacity-0 group-hover:opacity-100 transition-opacity
                                   flex items-center justify-center hover:bg-red-600"
                        title="Remove from library"
                      >
                        <TrashIcon />
                      </button>
                    </div>

                    {/* Book Info */}
                    <div>
                      <h3 className="font-medium text-sm text-[var(--color-ink)] line-clamp-2 group-hover:text-[var(--color-gold)] transition-colors">
                        {book.title}
                      </h3>
                      <p className="text-xs text-[var(--color-ink-muted)] mt-0.5 line-clamp-1">
                        {book.author}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          </section>
        )}

        {/* Empty State */}
        {books.length === 0 && (
          <section className="text-center py-16 animate-fade-in animate-fade-in-delay-3">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-[var(--color-paper-dark)] mb-6">
              <BookIcon />
            </div>
            <h3 className="text-xl font-serif text-[var(--color-ink)] mb-2">
              Your library is empty
            </h3>
            <p className="text-[var(--color-ink-muted)] max-w-md mx-auto">
              Add an EPUB book to get started. Your books will be stored locally
              and you can listen to them anytime, even offline.
            </p>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--color-sepia)] mt-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 text-center">
          <p className="text-xs text-[var(--color-ink-muted)]">
            Powered by WebGPU TTS &middot; All processing happens locally in your browser
          </p>
        </div>
      </footer>
    </div>
  );
}
