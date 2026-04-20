import { useMemo, useState, type ReactNode } from 'react';
import { Row, Col } from './Layout';
import { IconChev } from './icons';

/** Collapsible card with eyebrow + title; state optionally persisted to localStorage. */
export function CollapsibleSection({
  eyebrow,
  title,
  right,
  defaultOpen = true,
  children,
  storageKey,
}: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  storageKey?: string;
}) {
  const initial = useMemo(() => {
    if (storageKey && typeof window !== 'undefined') {
      const v = window.localStorage.getItem(storageKey);
      if (v === 'open') return true;
      if (v === 'closed') return false;
    }
    return defaultOpen;
  }, [defaultOpen, storageKey]);

  const [open, setOpen] = useState(initial);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, next ? 'open' : 'closed');
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  };

  return (
    <section
      className="card"
      style={{
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: open ? 16 : 0,
        transition: 'gap 180ms',
      }}
    >
      <Row justify="space-between" align="flex-start">
        <button
          type="button"
          onClick={toggle}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              display: 'inline-grid',
              placeItems: 'center',
              color: 'var(--fg-dim)',
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 180ms',
            }}
          >
            <IconChev size={12} />
          </span>
          <Col gap={2} style={{ minWidth: 0 }}>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && <h3 style={{ margin: 0 }}>{title}</h3>}
          </Col>
        </button>
        {open && right}
      </Row>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>}
    </section>
  );
}

/** Rail collapse — a thin eyebrow-chevron header used in the right rail. */
export function RailCollapse({
  eyebrow,
  children,
  storageKey,
  defaultOpen = true,
}: {
  eyebrow: ReactNode;
  children: ReactNode;
  storageKey?: string;
  defaultOpen?: boolean;
}) {
  const initial = useMemo(() => {
    if (storageKey && typeof window !== 'undefined') {
      const v = window.localStorage.getItem(storageKey);
      if (v === 'open') return true;
      if (v === 'closed') return false;
    }
    return defaultOpen;
  }, [defaultOpen, storageKey]);

  const [open, setOpen] = useState(initial);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, next ? 'open' : 'closed');
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  };

  return (
    <Col gap={8}>
      <button
        type="button"
        onClick={toggle}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            display: 'inline-grid',
            placeItems: 'center',
            color: 'var(--fg-dim)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 180ms',
          }}
        >
          <IconChev size={10} />
        </span>
        <span className="eyebrow">{eyebrow}</span>
      </button>
      {open && children}
    </Col>
  );
}
