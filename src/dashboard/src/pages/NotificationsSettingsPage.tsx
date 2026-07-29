/**
 * Settings → Notifications (editor + admin).
 *
 * Per-device push notification controls. Uses token-based styling
 * (`.card`, `.btn`, CSS variables from tokens.css) so light + dark
 * themes both work without any per-component overrides.
 *
 * Browser support:
 *   Desktop Chrome/Edge/Firefox/Safari 16.1+ — works in any tab
 *   Android Chrome/Firefox                  — works in any tab
 *   iOS Safari 16.4+                        — only inside an installed PWA
 */

import { useEffect, useState, useCallback } from 'react';
import { SettingsShell } from '@/components/design';
import { useAuth } from '@/hooks/useAuth';
import * as api from '@/services/api';
import * as push from '@/services/push';
import type { PushPreferences, PushSubscriptionPublic, PushEventType } from '@/types/api';
import { formatTimeAgo } from '@/utils/formatters';

interface EventDescriptor {
  key: PushEventType;
  label: string;
  description: string;
}

const EVENT_DESCRIPTORS: EventDescriptor[] = [
  {
    key: 'broadcast_started',
    label: 'Broadcast started',
    description: 'Fires when a broadcast day transitions from scheduled to live.',
  },
  {
    key: 'broadcast_ending',
    label: 'Broadcast about to end',
    description: '~10 minutes before scheduled end — useful for extending if running over.',
  },
  {
    key: 'polling_stalled',
    label: 'Polling stalled',
    description: '5 consecutive cycles returned zero results. Check adapter health.',
  },
  {
    key: 'quota_exhausted',
    label: 'YouTube quota exhausted',
    description: 'Daily quota fully consumed — discovery falls back to scraping.',
  },
  {
    key: 'discovery_candidate',
    label: 'New discovery candidate',
    description: 'Auto-discovery found a channel waiting for approval.',
  },
  {
    key: 'data_anomaly',
    label: 'Data anomaly',
    description:
      'Stream Together inflation detected, scraper tab-bleed signature, an official channel flatlining, or a sharp total-CCV collapse.',
  },
];

const DEFAULT_PREFS: PushPreferences = {
  broadcast_started: true,
  broadcast_ending: true,
  polling_stalled: true,
  quota_exhausted: true,
  discovery_candidate: true,
  data_anomaly: true,
};

export function NotificationsSettingsPage() {
  const { user, isEditor } = useAuth();

  const [pushStatus, setPushStatus] = useState<push.PushStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subs, setSubs] = useState<PushSubscriptionPublic[]>([]);
  const [thisDevicePrefs, setThisDevicePrefs] = useState<PushPreferences>(DEFAULT_PREFS);
  const [testFlash, setTestFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await push.getPushStatus();
      setPushStatus(status);
      const list = await api.listPushSubscriptions();
      setSubs(list.subscriptions);
      const mine = status.endpoint
        ? list.subscriptions.find((s) => s.endpoint === status.endpoint)
        : null;
      if (mine) setThisDevicePrefs(mine.preferences);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
  }, [user, refresh]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleEnable = async () => {
    setError(null);
    setWorking(true);
    try {
      const result = await push.enablePush();
      if (!result.ok) {
        setError(result.reason);
      } else {
        await refresh();
      }
    } finally {
      setWorking(false);
    }
  };

  const handleDisable = async () => {
    setError(null);
    setWorking(true);
    try {
      const result = await push.disablePush();
      if (!result.ok) setError(result.reason ?? 'Disable failed');
      await refresh();
    } finally {
      setWorking(false);
    }
  };

  const handleTogglePref = async (key: PushEventType, value: boolean) => {
    if (!pushStatus?.endpoint) return;
    const next = { ...thisDevicePrefs, [key]: value };
    setThisDevicePrefs(next); // optimistic
    try {
      await api.updatePushPreferences(pushStatus.endpoint, { [key]: value });
    } catch (err) {
      // revert
      setThisDevicePrefs(thisDevicePrefs);
      setError((err as Error).message);
    }
  };

  const handleSendTest = async () => {
    setError(null);
    setTestFlash(null);
    try {
      const r = await api.sendTestPush();
      const msg = r.sent > 0
        ? `Server pushed to ${r.sent} device${r.sent === 1 ? '' : 's'} (FCM accepted). If you don't see a banner within 10 seconds, check macOS Notifications → Chrome.`
        : r.pruned > 0
          ? `${r.pruned} subscription was expired and pruned. Click Disable then Enable to re-subscribe.`
          : 'No active subscriptions found for your account.';
      setTestFlash(msg);
      setTimeout(() => setTestFlash(null), 12_000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleShowLocalTest = async () => {
    setError(null);
    setTestFlash(null);
    if (!('Notification' in window)) {
      setError('This browser does not support notifications.');
      return;
    }
    if (Notification.permission !== 'granted') {
      setError('Notification permission is not granted. Click Enable above first.');
      return;
    }
    try {
      const n = new Notification('Local test notification', {
        body: 'Direct from this tab — no server, no push pipeline. If you see this, OS permissions are fine.',
        icon: '/favicon-192.png',
        tag: 'local-test',
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      setTestFlash('Local test fired. If you see a banner, OS-level permissions are working — any failure with "Send server test" is in the push pipeline (SW or FCM).');
      setTimeout(() => setTestFlash(null), 12_000);
    } catch (err) {
      setError(`Local notification failed: ${(err as Error).message}`);
    }
  };

  const handleRemoveDevice = async (endpoint: string) => {
    setWorking(true);
    try {
      await api.unsubscribeFromPush(endpoint);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  // ── Auth gate ──────────────────────────────────────────────────────────

  if (!user || !isEditor) {
    return (
      <SettingsShell breadcrumb="Settings · Notifications" title="Push notifications">
        <div style={{ padding: 32 }}>
          <div className="card" style={{ padding: 20 }}>
            <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: 0 }}>
              Notifications are available for editors and admins.
            </p>
          </div>
        </div>
      </SettingsShell>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const enabled = pushStatus?.isSubscribed ?? false;
  const enableDisabled =
    working ||
    pushStatus?.status === 'unsupported' ||
    pushStatus?.status === 'unsupported-ios-safari' ||
    pushStatus?.status === 'permission-denied';

  return (
    <SettingsShell
      breadcrumb="Settings · Notifications"
      title="Push notifications"
      description="OS-level notifications for live operations: broadcasts going live or ending, polling problems, YouTube quota exhaustion, new discovery candidates. Each device configures independently."
    >
      <div>

        {error && (
          <div
            className="card"
            style={{
              padding: 14,
              marginBottom: 12,
              borderColor: 'var(--red)',
              background: 'var(--red-wash)',
            }}
          >
            <p style={{ color: 'var(--red)', fontSize: 13, margin: 0 }}>{error}</p>
          </div>
        )}

        {/* iOS Safari nudge */}
        {pushStatus?.status === 'unsupported-ios-safari' && (
          <div className="card" style={{ padding: 18, marginBottom: 14 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 6, color: 'var(--fg)' }}>
              One extra step on iPhone
            </h2>
            <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0, lineHeight: 1.5 }}>
              On iOS, Web Push only works for sites added to the Home Screen.
              Tap the Share button (□↑) at the bottom of Safari and choose <strong>Add to Home Screen</strong>.
              Then open the app from the new icon and come back here to enable notifications.
            </p>
          </div>
        )}

        {/* Permission denied recovery hint */}
        {pushStatus?.status === 'permission-denied' && (
          <div className="card" style={{ padding: 18, marginBottom: 14 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 6, color: 'var(--fg)' }}>
              Notifications were blocked
            </h2>
            <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0, lineHeight: 1.5 }}>
              You denied the permission prompt previously. To enable, click the lock icon
              in the address bar, set <strong>Notifications</strong> to <strong>Allow</strong>,
              then reload the page.
            </p>
          </div>
        )}

        {/* Status + Enable/Disable */}
        <div
          className="card"
          style={{
            padding: 20,
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 4 }}>
              This device
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: 'var(--fg)',
              }}
            >
              {statusLoading ? 'Checking…' : enabled ? (
                <>Enabled <StatusPill kind="on">on</StatusPill></>
              ) : pushStatus?.status === 'unsupported' || pushStatus?.status === 'unsupported-ios-safari' ? (
                <>Not supported <StatusPill kind="muted">unavailable</StatusPill></>
              ) : (
                <>Disabled <StatusPill kind="muted">off</StatusPill></>
              )}
            </div>
          </div>
          {enabled ? (
            <button type="button" className="btn btn-ghost" disabled={working} onClick={handleDisable}>
              Disable
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={enableDisabled}
              onClick={handleEnable}
            >
              Enable
            </button>
          )}
        </div>

        {/* Per-event toggles */}
        {enabled && (
          <>
            <div className="card" style={{ padding: 20, marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: 'var(--fg)' }}>
                What to be notified about
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 14 }}>
                Each toggle applies to this device only.
              </div>
              {EVENT_DESCRIPTORS.map((ev, i) => (
                <div
                  key={ev.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 0',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-faint)',
                    gap: 24,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>{ev.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                      {ev.description}
                    </div>
                  </div>
                  <ToggleSwitch
                    on={thisDevicePrefs[ev.key]}
                    onChange={(v) => handleTogglePref(ev.key, v)}
                  />
                </div>
              ))}
            </div>

            {/* Test notifications */}
            <div className="card" style={{ padding: 18, marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: 'var(--fg)' }}>
                Test notifications
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 14, lineHeight: 1.6 }}>
                Two ways to test, useful for diagnosing if a notification doesn't arrive:
                <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  <li>
                    <strong>Local test</strong> — fires <code>new Notification(…)</code> from this
                    tab directly. Skips the server, the Service Worker, and Google's push gateway.
                    If this doesn't appear, the problem is at the browser or OS permission layer.
                  </li>
                  <li style={{ marginTop: 4 }}>
                    <strong>Server test</strong> — full pipeline: server signs a Web Push payload
                    with VAPID, sends it to Google's FCM, FCM forwards to Chrome, Chrome wakes the
                    Service Worker, the SW calls <code>showNotification(…)</code>. Tests every link.
                  </li>
                </ul>
              </div>
              {testFlash && (
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--fg)',
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border)',
                    padding: 10,
                    borderRadius: 4,
                    marginBottom: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {testFlash}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn" onClick={handleShowLocalTest}>
                  Local test (skip server)
                </button>
                <button type="button" className="btn btn-primary" onClick={handleSendTest}>
                  Server test (full pipeline)
                </button>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--fg-dim)',
                  marginTop: 14,
                  lineHeight: 1.55,
                }}
              >
                <strong>If no banner appears for either test on macOS:</strong> open
                System Settings → Notifications → Google Chrome and make sure
                "Allow notifications" is on, with banner style set to Banners or
                Alerts. Focus modes can also silently filter notifications.
              </div>
            </div>
          </>
        )}

        {/* Device list */}
        {subs.length > 0 && (
          <div className="card" style={{ padding: 20, marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: 'var(--fg)' }}>
              Your subscribed devices
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 14 }}>
              {subs.length} device{subs.length === 1 ? '' : 's'} will receive your notifications.
            </div>
            {subs.map((s, i) => {
              const isThis = pushStatus?.endpoint === s.endpoint;
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 0',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-faint)',
                    gap: 16,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: 500,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: 'var(--fg)',
                    }}>
                      {summariseUserAgent(s.user_agent)}
                      {isThis && <StatusPill kind="info">this device</StatusPill>}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--fg-dim)',
                        fontFamily: 'var(--font-mono)',
                        marginTop: 3,
                      }}
                    >
                      Added {formatTimeAgo(s.created_at)}
                      {s.last_notified_at ? ` · last notified ${formatTimeAgo(s.last_notified_at)}` : ''}
                    </div>
                  </div>
                  {!isThis && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={working}
                      onClick={() => handleRemoveDevice(s.endpoint)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SettingsShell>
  );
}

// ── Status pill ───────────────────────────────────────────────────────────
// Theme-aware replacement for the dark-only Badge.

function StatusPill({ children, kind }: { children: React.ReactNode; kind: 'on' | 'muted' | 'info' }) {
  const styles: Record<typeof kind, React.CSSProperties> = {
    on: {
      background: 'color-mix(in oklab, var(--live) 16%, transparent)',
      color: 'var(--live)',
      borderColor: 'color-mix(in oklab, var(--live) 35%, transparent)',
    },
    muted: {
      background: 'var(--bg-hover)',
      color: 'var(--fg-muted)',
      borderColor: 'var(--border)',
    },
    info: {
      background: 'color-mix(in oklab, var(--info) 14%, transparent)',
      color: 'var(--info)',
      borderColor: 'color-mix(in oklab, var(--info) 35%, transparent)',
    },
  };
  return (
    <span
      style={{
        ...styles[kind],
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.3,
        fontFamily: 'var(--font-mono)',
        border: '1px solid',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}

// ── Mini toggle ───────────────────────────────────────────────────────────

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        position: 'relative',
        width: 38,
        height: 22,
        borderRadius: 999,
        border: '1px solid var(--border)',
        background: on ? 'var(--live)' : 'var(--bg-hover)',
        cursor: 'pointer',
        transition: 'background 120ms',
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 17 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'white',
          transition: 'left 120ms',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        }}
      />
    </button>
  );
}

// ── User-agent summary ────────────────────────────────────────────────────

function summariseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const isMobile = /iPhone|Android|Mobile/i.test(ua);
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let os = '';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';

  return `${isMobile ? 'Mobile' : 'Desktop'} · ${browser}${os ? ` (${os})` : ''}`;
}
