/**
 * SettingsShell — shared chrome for /settings/* pages.
 *
 * Mirrors the top bar used by StartPage / EditorDesktop so the settings
 * surfaces (Notifications, YouTube Keys, Users) inherit the redesigned
 * dashboard's look instead of falling through to the legacy MainLayout +
 * Sidebar chrome. There's no series scope here, so we keep the bar lean:
 * Clutch wordmark + "VIEWERSHIP TRACKER" tagline + a "← Series list"
 * back-link + theme toggle + user identity / sign-out.
 *
 * Cross-page nav (Users, YT Keys, Notifications, Explore) lives behind a
 * `⋯` overflow menu identical to EditorDesktop's account menu so editors
 * can jump between settings without going through the home page.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Row,
  ClutchWordmark,
  ThemeToggle,
  IconUsers,
} from '@/components/design';
import { useAuth } from '@/hooks/useAuth';

interface SettingsShellProps {
  /** Eyebrow above the page title (e.g. "SETTINGS · NOTIFICATIONS"). */
  breadcrumb: string;
  /** The page-level title shown in the top bar. */
  title: string;
  /** The actual page content. */
  children: ReactNode;
  /**
   * Optional series id to navigate back to instead of the series list.
   * If omitted, the back link goes to "/".
   */
  backToSeriesId?: string | null;
}

export function SettingsShell({ breadcrumb, title, children, backToSeriesId }: SettingsShellProps) {
  const navigate = useNavigate();
  const { user, logout, isAdmin, isEditor } = useAuth();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Click-outside handler for the overflow menu
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const handleBack = () => {
    if (backToSeriesId) navigate(`/${backToSeriesId}`);
    else navigate('/');
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-app)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top bar — matches StartPage / Editor / Report chrome */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'var(--bg-card)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Row
          justify="space-between"
          align="center"
          style={{ padding: '10px 22px', gap: 12 }}
        >
          <Row gap={10} align="center">
            <button
              type="button"
              onClick={handleBack}
              title={backToSeriesId ? 'Back to series' : 'Back to series list'}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <ClutchWordmark size={16} />
            </button>
            <span
              style={{
                fontSize: 10,
                color: 'var(--fg-dim)',
                letterSpacing: 1.2,
                fontFamily: 'var(--font-mono)',
                padding: '2px 8px',
                borderLeft: '1px solid var(--border)',
              }}
            >
              VIEWERSHIP TRACKER
            </span>
            <span
              aria-hidden
              style={{
                fontSize: 10,
                color: 'var(--fg-dim)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              ›
            </span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--fg)',
              }}
            >
              {title}
            </span>
          </Row>

          <Row gap={8} align="center">
            <button
              type="button"
              onClick={handleBack}
              className="btn"
              style={{
                fontSize: 12,
                padding: '5px 10px',
                background: 'transparent',
                border: '1px solid var(--border)',
              }}
              title={backToSeriesId ? 'Back to series' : 'Back to series list'}
            >
              ← {backToSeriesId ? 'Back' : 'Series list'}
            </button>

            <ThemeToggle />

            {/* Overflow menu — Users / YT Keys / Notifications / Sign out */}
            {user && (
              <div ref={menuRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  className="btn"
                  style={{
                    fontSize: 14,
                    padding: '4px 10px',
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    minWidth: 36,
                  }}
                  title={`${user.display_name} · ${user.role}`}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                >
                  ⋯
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 6px)',
                      right: 0,
                      minWidth: 220,
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                      padding: 4,
                      zIndex: 20,
                    }}
                  >
                    <div
                      style={{
                        padding: '8px 10px',
                        fontSize: 11,
                        color: 'var(--fg-dim)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {user.display_name} · {user.role.toUpperCase()}
                    </div>
                    <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />
                    <ShellMenuItem onClick={() => { setMenuOpen(false); navigate('/'); }}>
                      Series list
                    </ShellMenuItem>
                    {isEditor && (
                      <ShellMenuItem onClick={() => { setMenuOpen(false); navigate('/settings/notifications'); }}>
                        Notifications
                      </ShellMenuItem>
                    )}
                    {isAdmin && (
                      <>
                        <ShellMenuItem onClick={() => { setMenuOpen(false); navigate('/users'); }} icon={<IconUsers size={13} />}>
                          Users
                        </ShellMenuItem>
                        <ShellMenuItem onClick={() => { setMenuOpen(false); navigate('/settings/youtube-keys'); }}>
                          YouTube API keys
                        </ShellMenuItem>
                      </>
                    )}
                    <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />
                    <ShellMenuItem onClick={() => { setMenuOpen(false); logout(); }}>
                      Sign out
                    </ShellMenuItem>
                  </div>
                )}
              </div>
            )}
          </Row>
        </Row>

        {/* Sub-eyebrow under the title bar — page breadcrumb */}
        <div
          style={{
            padding: '6px 22px',
            borderTop: '1px solid var(--border-faint)',
            fontSize: 10,
            letterSpacing: 1.4,
            color: 'var(--fg-dim)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
          }}
        >
          {breadcrumb}
        </div>
      </header>

      {/* Page content area */}
      <main style={{ flex: 1, paddingBottom: 60 }}>{children}</main>
    </div>
  );
}

// ── Menu item ─────────────────────────────────────────────────────────────

function ShellMenuItem({
  onClick,
  children,
  icon,
}: {
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
}) {
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
        borderRadius: 4,
        cursor: 'pointer',
        color: 'var(--fg)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {icon}
      {children}
    </button>
  );
}
