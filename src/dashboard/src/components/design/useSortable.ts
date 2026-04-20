import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

export interface SortableState<T> {
  sort: keyof T;
  dir: SortDir;
  toggle: (k: keyof T) => void;
  sorted: T[];
}

/**
 * Sort-by-column hook. Returns the current sort key/dir, a toggle function,
 * and the sorted array. Initial click on a new key defaults to 'desc'.
 */
export function useSortable<T>(
  rows: T[],
  initialKey: keyof T,
  initialDir: SortDir = 'desc',
): SortableState<T> {
  const [sort, setSort] = useState<keyof T>(initialKey);
  const [dir, setDir] = useState<SortDir>(initialDir);

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sort as string];
      const bv = (b as Record<string, unknown>)[sort as string];
      const aVal = av ?? '';
      const bVal = bv ?? '';
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return dir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      const aN = Number(aVal) || 0;
      const bN = Number(bVal) || 0;
      return dir === 'asc' ? aN - bN : bN - aN;
    });
  }, [rows, sort, dir]);

  const toggle = (k: keyof T) => {
    if (sort === k) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(k);
      setDir('desc');
    }
  };

  return { sort, dir, toggle, sorted };
}
