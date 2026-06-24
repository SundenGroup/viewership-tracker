import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconChevDown } from './icons';

/**
 * Scrollable content area with an Expand / Collapse toggle.
 *
 * Collapsed, it caps at `collapsedMaxHeight` with an inner scrollbar.
 * Expanded, it removes the cap so the whole list shows and the page
 * scrolls instead (no more fiddly scroll-within-a-box). The toggle bar
 * only renders when the content actually overflows the cap, so short
 * lists stay clean. Expanded state is optionally persisted via
 * `storageKey` (localStorage), matching CollapsibleSection.
 */
export function ExpandableScroll({
  children,
  collapsedMaxHeight = 480,
  storageKey,
}: {
  children: ReactNode;
  collapsedMaxHeight?: number;
  storageKey?: string;
}) {
  const initial = useMemo(() => {
    if (storageKey && typeof window !== 'undefined') {
      const v = window.localStorage.getItem(storageKey);
      if (v === 'expanded') return true;
      if (v === 'collapsed') return false;
    }
    return false;
  }, [storageKey]);

  const [expanded, setExpanded] = useState(initial);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Observe the (uncapped) content wrapper so we know whether the cap is
  // actually clipping anything — the toggle only appears when it is.
  // ResizeObserver fires on mount and whenever rows are added/removed or
  // the inline editor drawer opens, keeping the toggle in sync.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setOverflowing(el.offsetHeight > collapsedMaxHeight + 4);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsedMaxHeight]);

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, next ? 'expanded' : 'collapsed');
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  };

  const showToggle = overflowing || expanded;

  return (
    <div>
      <div
        style={{
          maxHeight: expanded ? 'none' : collapsedMaxHeight,
          overflowY: expanded ? 'visible' : 'auto',
        }}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {showToggle && (
        <button
          type="button"
          onClick={toggle}
          style={{
            width: '100%',
            marginTop: 8,
            padding: '7px 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              display: 'inline-grid',
              placeItems: 'center',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 160ms',
            }}
          >
            <IconChevDown size={11} />
          </span>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      )}
    </div>
  );
}
