/**
 * InfoTip: a small question mark that keeps an explanation off the page.
 *
 * Hover or focus shows it, a tap toggles it (phones have no hover), Escape
 * or a click elsewhere closes it. Meant for the one or two sentences a
 * reader may want about a figure, never for content the page needs.
 */
import { useEffect, useId, useRef, useState } from 'react';

export interface InfoTipProps {
  /** Short paragraphs, shown one under the other. */
  lines: string[];
  /** Accessible name of the button, e.g. "About live views". */
  label: string;
  /** Which edge of the icon the popover lines up with. */
  align?: 'left' | 'right';
  /** Open above the icon when the figure it explains sits right below it. */
  placement?: 'top' | 'bottom';
  size?: number;
}

export function InfoTip({ lines, label, align = 'right', placement = 'bottom', size = 15 }: InfoTipProps) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const host = useRef<HTMLSpanElement | null>(null);
  const id = useId();
  const open = pinned || hover;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      if (host.current && !host.current.contains(e.target as Node)) setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  if (lines.length === 0) return null;

  return (
    <span
      ref={host}
      className="info-tip"
      style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((p) => !p);
        }}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border: '1px solid var(--border)',
          background: open ? 'var(--bg-sunken)' : 'transparent',
          color: 'var(--fg-dim)',
          fontSize: Math.round(size * 0.62),
          fontWeight: 600,
          lineHeight: 1,
          padding: 0,
          cursor: 'help',
          display: 'inline-grid',
          placeItems: 'center',
          fontFamily: 'var(--font-mono)',
        }}
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          style={{
            position: 'absolute',
            [placement === 'top' ? 'bottom' : 'top']: size + 8,
            [align]: -6,
            zIndex: 50,
            width: 'min(280px, 78vw)',
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            boxShadow: 'var(--shadow-md)',
            color: 'var(--fg-muted)',
            fontSize: 11.5,
            lineHeight: 1.5,
            fontWeight: 400,
            letterSpacing: 0,
            textTransform: 'none',
            textAlign: 'left',
            whiteSpace: 'normal',
            display: 'grid',
            gap: 6,
          }}
        >
          {lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
      )}
    </span>
  );
}
