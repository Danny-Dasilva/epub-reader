'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { parseEpub } from '@/lib/epub';
import { useLibraryStore, StoredBook } from '@/store/libraryStore';
import { usePlaybackStore } from '@/store/playbackStore';
import { migrateFromSessionStorage } from '@/lib/storage';
import { useLastReadBook } from '@/hooks/useLastReadBook';
import { ContinueReadingCard } from '@/components/ContinueReadingCard';

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

// Loading spinner component
const LoadingSpinner = () => (
  <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
);

// Fix #10: Error type with recovery options
interface ParseError {
  message: string;
  details?: string;
  canRetry: boolean;
}

export default function LibraryPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true); // Fix #7: Loading state for IndexedDB
  const [error, setError] = useState<ParseError | null>(null);

  const { books, addBook, removeBook, loadBooksFromDB, addBookToDB } = useLibraryStore();
  const enableIndexedDBStorage = usePlaybackStore(state => state.enableIndexedDBStorage);
  const lastReadBook = useLastReadBook();

  // Load books from IndexedDB on mount
  useEffect(() => {
    const initStorage = async () => {
      setIsLibraryLoading(true);
      try {
        if (enableIndexedDBStorage) {
          // Run migration from sessionStorage
          await migrateFromSessionStorage();

          // Load books from IndexedDB
          await loadBooksFromDB();
        }
      } catch (err) {
        console.error('Failed to load library:', err);
      } finally {
        setIsLibraryLoading(false);
      }
    };

    initStorage();
  }, [enableIndexedDBStorage, loadBooksFromDB]);

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.name.endsWith('.epub')) {
      setError({
        message: 'Invalid file type',
        details: 'Please select a valid EPUB file (.epub extension)',
        canRetry: true
      });
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const parsedBook = await parseEpub(arrayBuffer);
      addBook(parsedBook);

      // Save to IndexedDB if enabled, otherwise use sessionStorage
      if (enableIndexedDBStorage) {
        await addBookToDB(parsedBook);
      } else {
        // Fallback to sessionStorage
        sessionStorage.setItem(`book-${parsedBook.id}`, JSON.stringify(parsedBook));
      }

      // Navigate to reader
      router.push(`/reader/${parsedBook.id}`);
    } catch (err) {
      console.error('Failed to parse EPUB:', err);
      // Fix #10: Detailed error with recovery options
      setError({
        message: 'Failed to parse EPUB file',
        details: err instanceof Error ? err.message : 'The file may be corrupted or in an unsupported format',
        canRetry: true
      });
    } finally {
      setIsLoading(false);
    }
  }, [addBook, addBookToDB, enableIndexedDBStorage, router]);

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

  const handleDeleteBook = async (e: React.MouseEvent, bookId: string) => {
    e.stopPropagation();
    if (confirm('Remove this book from your library?')) {
      removeBook(bookId);

      // Delete from IndexedDB if enabled
      if (enableIndexedDBStorage) {
        const { getBookStorage } = await import('@/lib/storage');
        const storage = getBookStorage();
        await storage.deleteBook(bookId);
      } else {
        // Fallback to sessionStorage
        sessionStorage.removeItem(`book-${bookId}`);
      }
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
        {/* Continue Reading Section */}
        {lastReadBook && (
          <section className="mb-12 animate-fade-in">
            <ContinueReadingCard book={lastReadBook} />
          </section>
        )}

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

          {/* Fix #10: Enhanced error UI with recovery options */}
          {error && (
            <div className="mt-4 mx-auto max-w-md bg-red-50 border border-red-200 rounded-lg p-4 animate-fade-in">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-5 h-5 text-red-500 mt-0.5">
                  <svg viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h4 className="font-medium text-red-800 text-sm">
                    {error.message}
                  </h4>
                  {error.details && (
                    <p className="text-sm text-red-600 mt-1">
                      {error.details}
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    {error.canRetry && (
                      <button
                        onClick={() => {
                          setError(null);
                          fileInputRef.current?.click();
                        }}
                        className="px-3 py-1.5 text-sm font-medium text-red-700 bg-red-100 rounded-md hover:bg-red-200 transition-colors"
                      >
                        Try Again
                      </button>
                    )}
                    <button
                      onClick={() => setError(null)}
                      className="px-3 py-1.5 text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
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

        {/* Loading State (Fix #7) */}
        {isLibraryLoading && books.length === 0 && (
          <section className="text-center py-16 animate-fade-in">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-[var(--color-paper-dark)] mb-6 text-[var(--color-ink-muted)]">
              <LoadingSpinner />
            </div>
            <h3 className="text-xl font-serif text-[var(--color-ink)] mb-2">
              Loading your library...
            </h3>
            <p className="text-[var(--color-ink-muted)] max-w-md mx-auto">
              Please wait while we load your books from storage.
            </p>
          </section>
        )}

        {/* Empty State */}
        {!isLibraryLoading && books.length === 0 && (
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
