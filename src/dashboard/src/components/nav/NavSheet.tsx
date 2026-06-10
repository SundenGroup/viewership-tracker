/**
 * NavSheet — mobile (<900px) navigation sheet opened from TopNav's hamburger.
 *
 * Carries everything the desktop bar shows inline: primary nav items, the
 * series switcher, a "Series settings" shortcut when a series is active,
 * theme toggle, and user identity + sign-out.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Row, Col, ThemeToggle, IconX, IconSettings } from '@/components/design';
import { useAuth } from '@/hooks/useAuth';
import type { TournamentSeries } from '@/types/api';
import { SeriesSwitcher } from './SeriesSwitcher';
import type { NavItem } from './TopNav';

export function NavSheet({
  open,
  onClose,
  items,
  seriesList,
  activeSeriesId,
  onSeriesChange,
}: {
  open: boolean;
  onClose: () => void;
  items: NavItem[];
  seriesList: TournamentSeries[];
  activeSeriesId?: string | null;
  onSeriesChange: (id: string) => void;
}) {
  const navigate = useNavigate();
  const { user, logout, isEditor } = useAuth();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Navigation"
      style={{ position: 'fixed', inset: 0, zIndex: 90 }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(2px)',
        }}
      />
      {/* Panel */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(300px, 84vw)',
          background: 'var(--bg-card)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          padding: '14px 14px calc(14px + env(safe-area-inset-bottom))',
          gap: 12,
          overflowY: 'auto',
        }}
      >
        <Row justify="space-between" align="center">
          <span
            className="eyebrow"
            style={{ fontSize: 10, letterSpacing: 1.2, color: 'var(--fg-dim)' }}
          >
            MENU
          </span>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            aria-label="Close menu"
            style={{ padding: '5px 8px', background: 'transparent' }}
          >
            <IconX size={15} />
          </button>
        </Row>

        <Col gap={2}>
          {items.map((it) => (
            <SheetItem key={it.id} active={it.active} onClick={() => go(it.path)}>
              {it.label}
            </SheetItem>
          ))}
          {activeSeriesId && isEditor && (
            <SheetItem onClick={() => go(`/${activeSeriesId}/edit`)}>
              <Row gap={7} align="center">
                <IconSettings size={13} /> Series settings
              </Row>
            </SheetItem>
          )}
        </Col>

        <div style={{ height: 1, background: 'var(--border)' }} />

        <Col gap={6}>
          <span className="eyebrow" style={{ fontSize: 9.5, color: 'var(--fg-dim)' }}>
            SERIES
          </span>
          <SeriesSwitcher
            seriesList={seriesList}
            value={activeSeriesId}
            onChange={(id) => {
              onClose();
              onSeriesChange(id);
            }}
          />
        </Col>

        <div style={{ height: 1, background: 'var(--border)' }} />

        <Row justify="space-between" align="center">
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Theme</span>
          <ThemeToggle />
        </Row>

        <div style={{ flex: 1 }} />

        {user && (
          <Row justify="space-between" align="center" style={{ gap: 8 }}>
            <Col gap={0} style={{ minWidth: 0 }}>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.display_name}
              </span>
              <span
                style={{
                  fontSize: 9,
                  color: 'var(--fg-dim)',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: 0.5,
                }}
              >
                {user.role.toUpperCase()}
              </span>
            </Col>
            <button
              type="button"
              className="btn"
              onClick={() => {
                onClose();
                void logout();
              }}
              style={{ fontSize: 12, flexShrink: 0 }}
            >
              Sign out
            </button>
          </Row>
        )}
      </div>
    </div>
  );
}

function SheetItem({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        fontSize: 14,
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
        background: active ? 'var(--bg-hover)' : 'transparent',
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {active && (
        <span
          style={{
            width: 3,
            height: 14,
            borderRadius: 2,
            background: 'var(--red)',
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </button>
  );
}
