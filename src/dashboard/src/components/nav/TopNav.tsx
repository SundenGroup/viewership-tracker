/**
 * TopNav — the single persistent navigation bar for every authenticated
 * surface (StartPage, Editor, Explore, Discover, Settings, forms).
 *
 * Replaces the five parallel per-page top bars that grew organically
 * (legacy Header, StartPage header, ExploreShell, SettingsShell bar,
 * Editor headers). Public pages (/public/*) never render this.
 *
 * Layout (≥900px):
 *   [wordmark] | Home · Live · Explore · Discover · Settings | {contextSlot}
 *   …spacer… {actionsSlot} [LIVE pill] [WS dot] [SeriesSwitcher] [theme] [user]
 *
 * <900px: [wordmark] {contextSlot} …spacer… [LIVE pill] [hamburger → NavSheet]
 *
 * Height is fixed to var(--topnav-h) (tokens.css) so pages can offset their
 * own sticky elements with `top: var(--topnav-h)`.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Row, ClutchWordmark, ThemeToggle, IconMenu } from '@/components/design';
import { useAuth } from '@/hooks/useAuth';
import * as api from '@/services/api';
import { useViewportBelow } from '@/hooks/useViewport';
import { fmtRelative } from '@/design/format';
import type { ConnectionStatus } from '@/hooks/useWebSocket';
import type { OrchestratorStatus, TournamentSeries } from '@/types/api';
import { SeriesSwitcher } from './SeriesSwitcher';
import { NavSheet } from './NavSheet';

const LAST_SERIES_KEY = 'ct-last-series';

export interface TopNavProps {
  seriesList: TournamentSeries[];
  /** Series id from the URL when on a series-scoped page. */
  activeSeriesId?: string | null;
  pollingStatus?: OrchestratorStatus | null;
  /** Series-scoped WS status — only provided by editor surfaces. */
  wsStatus?: ConnectionStatus;
  /** Page context (e.g. editor breadcrumb) shown next to the tabs. */
  contextSlot?: ReactNode;
  /** Page actions (e.g. Export) shown on the right, before status. */
  actionsSlot?: ReactNode;
}

export interface NavItem {
  id: 'home' | 'live' | 'explore' | 'discover' | 'guide' | 'settings';
  label: string;
  path: string;
  active: boolean;
}

/** Resolve nav items + the "Live" target series for the current user/route. */
export function useNavItems(
  seriesList: TournamentSeries[],
  activeSeriesId?: string | null,
): NavItem[] {
  const location = useLocation();
  const { isAdmin, isEditor } = useAuth();
  const pathname = location.pathname;

  // "Live" should mean ON AIR, not "the series I looked at last". Prefer a
  // series with a live broadcast day (60s refresh); fall back to remembered
  // context only when nothing is broadcasting — and say so in the label.
  const [liveNow, setLiveNow] = useState<{ id: string; short: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .getLiveNow()
        .then((entries) => {
          if (cancelled) return;
          const e = entries[0];
          setLiveNow(e ? { id: e.series.id, short: e.series.short_name || e.series.name } : null);
        })
        .catch(() => {});
    load();
    const h = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, []);

  // Remember the last series the user visited so "Live" stays useful
  // when browsing Discover/Settings/Home.
  useEffect(() => {
    if (activeSeriesId) {
      try {
        localStorage.setItem(LAST_SERIES_KEY, activeSeriesId);
      } catch {
        /* ignore */
      }
    }
  }, [activeSeriesId]);

  return useMemo(() => {
    let lastSeries: string | null = null;
    try {
      lastSeries = localStorage.getItem(LAST_SERIES_KEY);
    } catch {
      /* ignore */
    }
    const validLast =
      lastSeries && seriesList.some((s) => s.id === lastSeries) ? lastSeries : null;
    const firstActive = seriesList.find((s) => s.status === 'active')?.id ?? null;
    const liveTarget = liveNow?.id ?? activeSeriesId ?? validLast ?? firstActive;
    const onLive = !!liveTarget && (pathname === `/${liveTarget}` || pathname === `/${liveTarget}/edit`);

    const onSettings = pathname.startsWith('/settings') || pathname === '/users';
    const onExplore = pathname.startsWith('/explore');
    const onDiscover = pathname.startsWith('/discover');

    const items: NavItem[] = [
      { id: 'home', label: 'Home', path: '/', active: pathname === '/' },
    ];
    if (liveTarget) {
      const targetSeries = seriesList.find((x) => x.id === liveTarget);
      const short = liveNow?.id === liveTarget
        ? liveNow.short
        : targetSeries?.short_name || targetSeries?.name || null;
      const label = short
        ? `Live · ${short.length > 12 ? `${short.slice(0, 12)}…` : short}`
        : 'Live';
      items.push({ id: 'live', label, path: `/${liveTarget}`, active: onLive });
    }
    if (isEditor) {
      items.push({
        id: 'explore',
        label: 'Explore',
        path: activeSeriesId && !onExplore ? `/explore/${activeSeriesId}` : '/explore',
        active: onExplore,
      });
    }
    items.push({ id: 'discover', label: 'Discover', path: '/discover', active: onDiscover });
    if (isAdmin || isEditor) {
      // Until the /settings hub lands (P3), deep-link to the first allowed page.
      items.push({
        id: 'settings',
        label: 'Settings',
        path: isAdmin ? '/settings/users' : '/settings/notifications',
        active: onSettings,
      });
    }
    return items;
  }, [seriesList, activeSeriesId, pathname, isAdmin, isEditor, liveNow]);
}

export function TopNav({
  seriesList,
  activeSeriesId,
  pollingStatus,
  wsStatus,
  contextSlot,
  actionsSlot,
}: TopNavProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const isNarrow = useViewportBelow(900);
  const items = useNavItems(seriesList, activeSeriesId);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);

  const isPollingLive = pollingStatus?.state === 'running';

  const handleSeriesChange = (id: string) => {
    // Context-aware: switching series on Explore stays on Explore.
    if (location.pathname.startsWith('/explore')) navigate(`/explore/${id}`);
    else navigate(`/${id}`);
  };

  return (
    <>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          height: 'var(--topnav-h)',
          boxSizing: 'border-box',
          background: 'var(--bg-card)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '0 18px',
          }}
        >
          {/* Left: brand + tabs + page context */}
          <Row gap={isNarrow ? 10 : 14} align="center" style={{ minWidth: 0, flex: 1 }}>
            <button
              type="button"
              onClick={() => navigate('/')}
              title="Home"
              aria-label="Home"
              style={{
                background: 'transparent',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                color: 'inherit',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <ClutchWordmark size={15} />
            </button>

            {!isNarrow && (
              <nav aria-label="Primary" style={{ display: 'flex', gap: 2, height: '100%' }}>
                {items.map((it) => (
                  <NavTab key={it.id} item={it} onClick={() => navigate(it.path)} />
                ))}
              </nav>
            )}

            {contextSlot && (
              <Row
                gap={8}
                align="center"
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  paddingLeft: 10,
                  borderLeft: '1px solid var(--border)',
                }}
              >
                {contextSlot}
              </Row>
            )}
          </Row>

          {/* Right: actions + status + switcher + theme + user */}
          <Row gap={8} align="center" style={{ flexShrink: 0 }}>
            {!isNarrow && actionsSlot}

            {isPollingLive && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 10.5,
                  fontWeight: 600,
                  padding: '2px 7px',
                  borderRadius: 3,
                  background: 'color-mix(in oklab, var(--live) 14%, transparent)',
                  color: 'var(--live)',
                  letterSpacing: 0.3,
                  fontFamily: 'var(--font-mono)',
                }}
                title={
                  pollingStatus?.lastPollTime
                    ? `Polling · last cycle ${fmtRelative(pollingStatus.lastPollTime)}`
                    : 'Polling is running'
                }
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--live)',
                    boxShadow: '0 0 6px var(--live)',
                  }}
                />
                POLLING
              </span>
            )}

            {wsStatus && !isNarrow && <WsDot status={wsStatus} />}

            {isNarrow ? (
              <button
                type="button"
                className="btn"
                onClick={() => setSheetOpen(true)}
                title="Menu"
                aria-label="Open navigation menu"
                style={{ padding: '5px 8px', background: 'transparent' }}
              >
                <IconMenu size={17} />
              </button>
            ) : (
              <>
                <SeriesSwitcher
                  seriesList={seriesList}
                  value={activeSeriesId}
                  onChange={handleSeriesChange}
                />
                <ThemeToggle />
                {user && (
                  <div ref={userMenuRef} style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={() => setUserMenuOpen((v) => !v)}
                      title={`${user.display_name} · ${user.role}`}
                      aria-expanded={userMenuOpen}
                      aria-haspopup="menu"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        gap: 0,
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '2px 4px 2px 10px',
                        borderLeft: '1px solid var(--border)',
                        color: 'var(--fg)',
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.2 }}>
                        {user.display_name}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          color: 'var(--fg-dim)',
                          letterSpacing: 0.5,
                          fontFamily: 'var(--font-mono)',
                          lineHeight: 1.2,
                        }}
                      >
                        {user.role.toUpperCase()}
                      </span>
                    </button>
                    {userMenuOpen && (
                      <div
                        role="menu"
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 'calc(100% + 8px)',
                          minWidth: 160,
                          background: 'var(--bg-card)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          boxShadow: 'var(--shadow-md)',
                          padding: 4,
                          zIndex: 50,
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="btn"
                          onClick={() => {
                            setUserMenuOpen(false);
                            navigate('/guide');
                          }}
                          style={{
                            width: '100%',
                            justifyContent: 'flex-start',
                            background: 'transparent',
                            border: 'none',
                            fontSize: 13,
                          }}
                        >
                          Guide
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="btn"
                          onClick={() => {
                            setUserMenuOpen(false);
                            void logout();
                          }}
                          style={{
                            width: '100%',
                            justifyContent: 'flex-start',
                            background: 'transparent',
                            border: 'none',
                            fontSize: 13,
                          }}
                        >
                          Sign out
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </Row>
        </div>

        {/* Brand accent strip */}
        <div
          style={{
            height: 2,
            flexShrink: 0,
            background:
              'linear-gradient(90deg, var(--red), color-mix(in oklab, var(--red) 50%, transparent), transparent)',
          }}
        />
      </header>

      {isNarrow && (
        <NavSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          items={items}
          seriesList={seriesList}
          activeSeriesId={activeSeriesId}
          onSeriesChange={handleSeriesChange}
        />
      )}
    </>
  );
}

// ── Nav tab ────────────────────────────────────────────────────────────────

function NavTab({ item, onClick }: { item: NavItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={item.active ? 'page' : undefined}
      style={{
        position: 'relative',
        padding: '0 11px',
        height: '100%',
        minHeight: 34,
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 12.5,
        fontWeight: item.active ? 600 : 500,
        color: item.active ? 'var(--fg)' : 'var(--fg-muted)',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {item.label}
      {item.active && (
        <span
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 0,
            height: 2,
            borderRadius: 1,
            background: 'var(--red)',
          }}
        />
      )}
    </button>
  );
}

// ── WS status dot ──────────────────────────────────────────────────────────

function WsDot({ status }: { status: ConnectionStatus }) {
  // Color-only signals are invisible to screen readers — and to a chunk
  // of colorblind users. Expose the state as text too.
  const color =
    status === 'connected'
      ? 'var(--live)'
      : status === 'connecting' || status === 'reconnecting'
        ? 'var(--warn)'
        : 'var(--danger)';
  return (
    <span
      title={`Live feed: ${status}`}
      role="img"
      aria-label={`Live feed ${status}`}
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        boxShadow: status === 'connected' ? '0 0 6px var(--live)' : 'none',
        flexShrink: 0,
      }}
    />
  );
}
