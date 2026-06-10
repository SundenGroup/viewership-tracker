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

import { type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Row } from '@/components/design';
import { useAuth } from '@/hooks/useAuth';

/** Settings sections, filtered by role at render time. */
export function useSettingsNav(): Array<{ id: string; label: string; path: string }> {
  const { isAdmin, isEditor } = useAuth();
  const nav: Array<{ id: string; label: string; path: string }> = [];
  if (isAdmin) nav.push({ id: 'users', label: 'Users', path: '/settings/users' });
  if (isAdmin) nav.push({ id: 'youtube', label: 'YouTube API keys', path: '/settings/youtube-keys' });
  if (isEditor) nav.push({ id: 'notifications', label: 'Notifications', path: '/settings/notifications' });
  return nav;
}

interface SettingsShellProps {
  /** Eyebrow above the page title (e.g. "SETTINGS · NOTIFICATIONS"). */
  breadcrumb: string;
  /** The page-level title. */
  title: string;
  /** The actual page content. */
  children: ReactNode;
  /** @deprecated TopNav owns global back/brand now. */
  backToSeriesId?: string | null;
}

/**
 * SettingsShell — content frame for /settings/* pages. The global TopNav
 * supplies brand / theme / account / nav, so this is just a left section
 * rail (≥900px) + breadcrumb + content. No top bar of its own.
 */
export function SettingsShell({ breadcrumb, title, children }: SettingsShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const nav = useSettingsNav();

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 22px 60px', width: '100%', boxSizing: 'border-box' }}>
      <div className="eyebrow" style={{ fontSize: 10, letterSpacing: 1.4, color: 'var(--fg-dim)', marginBottom: 6 }}>
        {breadcrumb}
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', margin: '0 0 20px' }}>{title}</h1>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr)',
          gap: 22,
        }}
        className="settings-grid"
      >
        {nav.length > 1 && (
          <Row gap={6} align="center" style={{ flexWrap: 'wrap', marginBottom: 4 }}>
            {nav.map((n) => {
              const active = location.pathname === n.path;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => navigate(n.path)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 999,
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 500,
                    border: `1px solid ${active ? 'var(--red)' : 'var(--border)'}`,
                    background: active ? 'var(--red-wash)' : 'var(--bg-card)',
                    color: active ? 'var(--red)' : 'var(--fg-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {n.label}
                </button>
              );
            })}
          </Row>
        )}
        <div>{children}</div>
      </div>
    </div>
  );
}
