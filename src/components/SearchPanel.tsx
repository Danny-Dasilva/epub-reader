'use client';

import { memo, useCallback, useEffect, useRef } from 'react';
import { SearchResult, getMatchContext } from '@/lib/epub/searchIndex';

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResult[];
  totalMatches: number;
  isSearching: boolean;
  onResultClick: (chapterIndex: number, sentenceIndex: number) => void;
}

// rendering-hoist-jsx: Hoisted static SVG icons outside components to avoid
// re-creation on every render.
const searchIcon = (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const closeIcon = (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// rerender-memo: Memoized result row so individual results don't re-render
// when other results or panel state changes.
const SearchResultItem = memo(function SearchResultItem({
  result,
  index,
  onResultClick,
}: {
  result: SearchResult;
  index: number;
  onResultClick: (result: SearchResult) => void;
}) {
  const context = getMatchContext(result.text, result.matchStart, result.matchEnd);
  return (
    <button
      key={`${result.sentenceId}-${result.matchStart}-${index}`}
      className="search-result"
      onClick={() => onResultClick(result)}
    >
      <span className="search-result-chapter">{result.chapterTitle}</span>
      {result.pageNumber > 0 ? (
        <span className="search-result-location">
          Chapter {result.chapterIndex + 1}, Page {result.pageNumber}
        </span>
      ) : null}
      <span className="search-result-text">
        <span className="search-result-context">{context.prefix}</span>
        <mark className="search-result-match">{context.match}</mark>
        <span className="search-result-context">{context.suffix}</span>
      </span>
    </button>
  );
});

/**
 * Search panel component for searching within a book.
 * Shows search input and results list with highlighted matches.
 */
export const SearchPanel = memo(function SearchPanel({
  isOpen,
  onClose,
  query,
  onQueryChange,
  results,
  totalMatches,
  isSearching,
  onResultClick
}: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Handle result click
  const handleResultClick = useCallback((result: SearchResult) => {
    onResultClick(result.chapterIndex, result.sentenceIndex);
    onClose();
  }, [onResultClick, onClose]);

  if (!isOpen) return null;

  return (
    <div className="search-panel">
      {/* Search Input */}
      <div className="search-input-container">
        {searchIcon}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search in book..."
          className="search-input"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {query ? (
          <button
            className="search-clear-btn"
            onClick={() => onQueryChange('')}
            title="Clear search"
          >
            {closeIcon}
          </button>
        ) : null}
        <button
          className="search-close-btn"
          onClick={onClose}
          title="Close search"
        >
          {closeIcon}
        </button>
      </div>

      {/* Results */}
      <div className="search-results">
        {isSearching ? (
          <div className="search-status">Searching...</div>
        ) : query.length > 0 && query.length < 2 ? (
          <div className="search-status">Type at least 2 characters</div>
        ) : query.length >= 2 && results.length === 0 ? (
          <div className="search-status">No matches found</div>
        ) : results.length > 0 ? (
          <>
            <div className="search-count">
              {totalMatches === results.length
                ? `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`
                : `Showing ${results.length} of ${totalMatches} matches`}
            </div>
            <div className="search-results-list">
              {results.map((result, index) => (
                <SearchResultItem
                  key={`${result.sentenceId}-${result.matchStart}-${index}`}
                  result={result}
                  index={index}
                  onResultClick={handleResultClick}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
});
