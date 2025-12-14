'use client';

import { memo, useState, useEffect, useRef } from 'react';

interface PageIndicatorProps {
  currentPage: number;
  totalPages: number;
}

/**
 * Page indicator component that displays in the left margin.
 * Styled like traditional book marginalia - subtle, elegant, and unobtrusive.
 *
 * Features:
 * - Fixed position in left margin
 * - Subtle fade animation when page changes
 * - Hidden on mobile where no margin exists
 */
export const PageIndicator = memo(function PageIndicator({
  currentPage,
  totalPages
}: PageIndicatorProps) {
  const [isChanging, setIsChanging] = useState(false);
  const prevPage = useRef(currentPage);

  // Animate on page change
  useEffect(() => {
    if (prevPage.current !== currentPage && currentPage > 0) {
      setIsChanging(true);
      const timer = setTimeout(() => setIsChanging(false), 400);
      prevPage.current = currentPage;
      return () => clearTimeout(timer);
    }
  }, [currentPage]);

  if (currentPage <= 0) return null;

  return (
    <div
      className={`page-indicator ${isChanging ? 'changing' : ''}`}
      aria-label={`Page ${currentPage} of ${totalPages}`}
    >
      <span className="page-indicator-number">{currentPage}</span>
    </div>
  );
});
