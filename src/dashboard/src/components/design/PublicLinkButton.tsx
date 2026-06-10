/**
 * PublicLinkButton — one-click access to a series' PUBLIC surfaces.
 *
 * Solves "the only way to get the public link was the Export dialog". When a
 * series is public + has a short_name it opens a small menu:
 *   · Open live dashboard   (/public/:short)
 *   · Copy link             (clipboard)
 *   · Detailed report       (/public/:short/report/detailed)
 *   · Simple report         (/public/:short/report/simple)
 *
 * When the series isn't public (or has no short_name) it renders dimmed and
 * the menu explains why; editors get an "Enable in Series settings →" jump
 * to /:id/edit?focus=public.
 *
 * Variants:
 *   · button     — full pill (editor header)
 *   · icon       — compact share glyph (series cards; stops propagation)
 *   · menu-item  — full-width row (mobile nav sheet)
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Row } from './Layout';
import { IconShare, IconExternal, IconCheck } from './icons';

export interface PublicSeriesRef {
  id: string;
  name: string;
  short_name: string | null;
  is_public: boolean;
}

export function publicUrls(series: Pick<PublicSeriesRef, 'short_name'>) {
  const short = series.short_name?.trim();
  if (!short) return null;
  const base = `${window.location.origin}/public/${short}`;
  return {
    live: base,
    detailed: `${base}/report/detailed`,
    simple: `${base}/report/simple`,
  };
}

export function PublicLinkButton({
  series,
  variant = 'button',
  canEdit = false,
}: {
  series: PublicSeriesRef | null | undefined;
  variant?: 'button' | 'icon' | 'menu-item';
  canEdit?: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

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

  const urls = series ? publicUrls(series) : null;
  const ready = !!series?.is_public && !!urls;

  const copy = () => {
    if (!urls) return;
    navigator.clipboard
      .writeText(urls.live)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {
        /* ignore */
      });
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setOpen((v) => !v);
  };

  // ── Trigger ──────────────────────────────────────────────────────────────
  let trigger: React.ReactNode;
  if (variant === 'icon') {
    trigger = (
      <button
        type="button"
        onClick={toggle}
        title={ready ? 'Public links' : 'Not public yet'}
        aria-label="Public links"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 5,
          borderRadius: 6,
          background: 'transparent',
          border: '1px solid var(--border)',
          color: ready ? 'var(--fg-muted)' : 'var(--fg-dim)',
          opacity: ready ? 1 : 0.55,
          cursor: 'pointer',
        }}
      >
        <IconShare size={13} />
      </button>
    );
  } else if (variant === 'menu-item') {
    trigger = (
      <button
        type="button"
        onClick={toggle}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '10px 12px',
          fontSize: 14,
          fontWeight: 500,
          color: ready ? 'var(--fg)' : 'var(--fg-muted)',
          background: 'transparent',
          border: 'none',
          borderRadius: 8,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <IconShare size={14} /> Public link
      </button>
    );
  } else {
    trigger = (
      <button
        type="button"
        className="btn"
        onClick={toggle}
        title={ready ? 'Public links' : 'Not public yet'}
        style={{ opacity: ready ? 1 : 0.6 }}
      >
        <IconShare size={13} /> Public
      </button>
    );
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: variant === 'menu-item' ? 'block' : 'inline-flex' }}>
      {trigger}
      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            minWidth: 240,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-md)',
            padding: 4,
            zIndex: 60,
          }}
        >
          {ready && urls ? (
            <>
              <MenuRow onClick={() => { setOpen(false); window.open(urls.live, '_blank', 'noopener'); }}>
                <Row gap={8} align="center"><IconExternal size={13} /> Open live dashboard</Row>
              </MenuRow>
              <MenuRow onClick={() => { copy(); }}>
                <Row gap={8} align="center">
                  {copied ? <IconCheck size={13} /> : <IconShare size={13} />}
                  {copied ? 'Link copied' : 'Copy link'}
                </Row>
              </MenuRow>
            </>
          ) : (
            <div style={{ padding: '8px 10px' }}>
              <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                {series?.is_public
                  ? 'Public access is on, but this series has no short link name yet.'
                  : 'Public access is off for this series.'}
              </div>
              {canEdit && series && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => { setOpen(false); navigate(`/${series.id}/edit?focus=public`); }}
                  style={{ marginTop: 10, fontSize: 12, width: '100%', justifyContent: 'center' }}
                >
                  Enable in Series settings →
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        fontSize: 13,
        background: hover ? 'var(--bg-hover)' : 'transparent',
        border: 'none',
        borderRadius: 5,
        cursor: 'pointer',
        color: 'var(--fg)',
      }}
    >
      {children}
    </button>
  );
}
