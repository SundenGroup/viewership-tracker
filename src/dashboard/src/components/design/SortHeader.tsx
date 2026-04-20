import type { ReactNode } from 'react';
import type { SortDir } from './useSortable';

export function SortHeader<K extends string>({
  sort,
  dir,
  onClick,
  id,
  children,
  align = 'left',
}: {
  sort: K;
  dir: SortDir;
  onClick: (k: K) => void;
  id: K;
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
}) {
  const active = sort === id;
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: active ? 'var(--fg)' : 'var(--fg-dim)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        width: '100%',
        justifyContent:
          align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
        textAlign: align,
      }}
    >
      {children}
      {active && <span>{dir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );
}
