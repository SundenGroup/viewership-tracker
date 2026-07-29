/**
 * LoadingBlock + EmptyState — the two halves of "don't flash an empty
 * table while fetching".
 *
 * Most Discover surfaces used to render their empty markup during the
 * first fetch, so every tab switch flashed "no data" for a beat. The rule
 * now: while a fetch is in flight show LoadingBlock; only after it
 * resolves empty show EmptyState. Both are deliberately quiet.
 */
import type { ReactNode } from 'react';
import { Spinner } from '../common/Loader';

export function LoadingBlock({ minHeight = 160 }: { minHeight?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight,
      }}
    >
      <Spinner size="md" />
    </div>
  );
}

export function EmptyState({
  children,
  minHeight = 120,
}: {
  children: ReactNode;
  minHeight?: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight,
        fontSize: 12.5,
        color: 'var(--fg-muted)',
        textAlign: 'center',
        padding: '12px 0',
      }}
    >
      {children}
    </div>
  );
}
