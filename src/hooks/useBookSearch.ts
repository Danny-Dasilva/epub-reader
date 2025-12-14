'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ParsedBook } from '@/lib/epub';
import { searchBook, SearchResult, countMatches } from '@/lib/epub/searchIndex';
import { PaginationData } from '@/lib/epub/pagination';

interface UseBookSearchOptions {
  book: ParsedBook | null;
  pagination?: PaginationData | null;
  debounceMs?: number;
  maxResults?: number;
}

interface UseBookSearchReturn {
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  totalMatches: number;
  isSearching: boolean;
  clearSearch: () => void;
}

/**
 * Hook for searching within a book with debounced input.
 *
 * Features:
 * - Debounced search to avoid excessive computation
 * - Returns results with match positions for highlighting
 * - Provides total match count
 */
export function useBookSearch({
  book,
  pagination,
  debounceMs = 300,
  maxResults = 50
}: UseBookSearchOptions): UseBookSearchReturn {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Debounce the query
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (query.length < 2) {
      setDebouncedQuery('');
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedQuery(query);
      setIsSearching(false);
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [query, debounceMs]);

  // Perform search when debounced query changes
  const results = useMemo(() => {
    if (!book || !debouncedQuery) {
      return [];
    }
    return searchBook(book, debouncedQuery, pagination, maxResults);
  }, [book, debouncedQuery, pagination, maxResults]);

  // Get total match count
  const totalMatches = useMemo(() => {
    if (!book || !debouncedQuery) {
      return 0;
    }
    // If we got fewer results than max, that's the total
    if (results.length < maxResults) {
      return results.length;
    }
    // Otherwise count all matches
    return countMatches(book, debouncedQuery);
  }, [book, debouncedQuery, results.length, maxResults]);

  // Clear search
  const clearSearch = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
  }, []);

  return {
    query,
    setQuery,
    results,
    totalMatches,
    isSearching,
    clearSearch
  };
}
