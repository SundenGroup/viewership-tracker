/**
 * FilterMultiSelect — compact trigger + searchable checkbox popover for a
 * multi-value filter. Replaces flat walls of pill chips (e.g. 30–50 language
 * codes on the Explore page) with a single "Language · 3 ▾" control.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { IconChevDown, IconSearch, IconX } from './icons';

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

export function FilterMultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Defaults to true when there are more than 8 options. */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const canSearch = searchable ?? options.length > 8;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (o) => o.value.toLowerCase().includes(needle) || o.label.toLowerCase().includes(needle),
    );
  }, [options, q]);

  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    onChange(next);
  };

  const active = selected.length > 0;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 9px',
          borderRadius: 6,
          fontSize: 11.5,
          fontWeight: active ? 600 : 500,
          border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
          background: active ? 'var(--red-wash)' : 'var(--bg-card)',
          color: active ? 'var(--red)' : 'var(--fg-muted)',
          cursor: 'pointer',
        }}
      >
        {label}
        {active && (
          <span
            className="mono"
            style={{
              fontSize: 10,
              padding: '0 5px',
              borderRadius: 999,
              background: 'var(--red)',
              color: '#fff',
            }}
          >
            {selected.length}
          </span>
        )}
        {active ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Clear ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            style={{ display: 'inline-flex' }}
          >
            <IconX size={11} />
          </span>
        ) : (
          <IconChevDown size={12} />
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            minWidth: 220,
            maxWidth: 280,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-md)',
            padding: 6,
            zIndex: 50,
          }}
        >
          {canSearch && (
            <div style={{ position: 'relative', marginBottom: 6 }}>
              <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-dim)', pointerEvents: 'none' }}>
                <IconSearch size={11} />
              </span>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                style={{
                  width: '100%',
                  padding: '5px 8px 5px 24px',
                  fontSize: 12,
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  color: 'var(--fg)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '8px 6px', fontSize: 12, color: 'var(--fg-dim)' }}>No matches</div>
            )}
            {filtered.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 7px',
                    fontSize: 12.5,
                    background: on ? 'var(--bg-hover)' : 'transparent',
                    border: 'none',
                    borderRadius: 5,
                    cursor: 'pointer',
                    color: 'var(--fg)',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      border: `1px solid ${on ? 'var(--red)' : 'var(--border-strong)'}`,
                      background: on ? 'var(--red)' : 'transparent',
                      color: '#fff',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      flexShrink: 0,
                    }}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.label}
                  </span>
                  {o.count != null && (
                    <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>{o.count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
