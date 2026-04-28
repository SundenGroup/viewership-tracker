/**
 * Settings → Notifications (editor + admin).
 *
 * Per-device push notification controls. Mirrors the auth-gate / page-shell
 * pattern of YouTubeKeysPage, but the role bar is editor+ instead of admin.
 *
 * Browser support:
 *   Desktop Chrome/Edge/Firefox/Safari 16.1+ — works in any tab
 *   Android Chrome/Firefox                  — works in any tab
 *   iOS Safari 16.4+                        — only inside an installed PWA
 *
 * The page renders a friendly fallback for non-editor users and a different
 * fallback (with install instructions) for iOS Safari users not in PWA mode.
 */

import { useEffect, useState, useCallback } from 'react';
import { Card, Button, Badge } from '@/components/common';
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
];

const DEFAULT_PREFS: PushPreferences = {
  broadcast_started: true,
  broadcast_ending: true,
  polling_stalled: true,
  quota_exhausted: true,
  discovery_candidate: true,
};

export function NotificationsSettingsPage() {
  const { user, isEditor, isAdmin } = useAuth();

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
      setTestFlash(`Test sent — ${r.sent} delivered, ${r.failed} failed, ${r.pruned} expired.`);
      setTimeout(() => setTestFlash(null), 6000);
    } catch (err) {
      setError((err as Error).message);
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
      <div style={{ padding: 32 }}>
        <Card>
          <p style={{ padding: 20, fontSize: 14, color: 'var(--fg-muted, #9ca3af)' }}>
            Notifications are available for editors and admins.
          </p>
        </Card>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const enabled = pushStatus?.isSubscribed ?? false;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 880, margin: '0 auto' }}>
      <div style={{ marginBottom: 18 }}>
        <div className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-dim, #6b7280)', marginBottom: 4 }}>
          SETTINGS · NOTIFICATIONS
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Push notifications</h1>
        <p style={{ fontSize: 13, color: 'var(--fg-muted, #9ca3af)', marginTop: 6, maxWidth: 720 }}>
          Get OS-level notifications for live operations: broadcasts going live or about to end,
          polling problems, YouTube quota exhaustion, and new auto-discovery candidates.
          Configure each device independently — your laptop and phone can have different
          preferences.
        </p>
      </div>

      {error && (
        <Card>
          <p style={{ padding: 14, color: 'var(--clutch-red, #FF154D)', fontSize: 13 }}>{error}</p>
        </Card>
      )}

      {/* iOS Safari nudge */}
      {pushStatus?.status === 'unsupported-ios-safari' && (
        <Card>
          <div style={{ padding: 18 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 6 }}>
              One extra step on iPhone
            </h2>
            <p style={{ fontSize: 13, color: 'var(--fg-muted, #9ca3af)', margin: 0, lineHeight: 1.5 }}>
              On iOS, Web Push only works for sites added to the Home Screen.
              Tap the Share button (□↑) at the bottom of Safari and choose <strong>Add to Home Screen</strong>.
              Then open the app from the new icon and come back here to enable notifications.
            </p>
          </div>
        </Card>
      )}

      {/* Permission denied recovery hint */}
      {pushStatus?.status === 'permission-denied' && (
        <Card>
          <div style={{ padding: 18 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 6 }}>
              Notifications were blocked
            </h2>
            <p style={{ fontSize: 13, color: 'var(--fg-muted, #9ca3af)', margin: 0, lineHeight: 1.5 }}>
              You denied the permission prompt previously. To enable, click the lock icon
              in the address bar, set <strong>Notifications</strong> to <strong>Allow</strong>,
              then reload the page.
            </p>
          </div>
        </Card>
      )}

      {/* Status + Enable/Disable */}
      <div style={{ height: 14 }} />
      <Card>
        <div
          style={{
            padding: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: 'var(--fg-muted, #9ca3af)', marginBottom: 4 }}>
              This device
            </div>
            <div style={{ fontSize: 16, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 10 }}>
              {statusLoading ? (
                'Checking…'
              ) : enabled ? (
                <>
                  Enabled <Badge variant="success">on</Badge>
                </>
              ) : pushStatus?.status === 'unsupported' || pushStatus?.status === 'unsupported-ios-safari' ? (
                <>
                  Not supported <Badge variant="default">unavailable</Badge>
                </>
              ) : (
                <>
                  Disabled <Badge variant="default">off</Badge>
                </>
              )}
            </div>
          </div>
          {enabled ? (
            <Button variant="ghost" disabled={working} onClick={handleDisable}>
              Disable
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={
                working ||
                pushStatus?.status === 'unsupported' ||
                pushStatus?.status === 'unsupported-ios-safari' ||
                pushStatus?.status === 'permission-denied'
              }
              onClick={handleEnable}
            >
              Enable
            </Button>
          )}
        </div>
      </Card>

      {/* Per-event toggles */}
      {enabled && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>What to be notified about</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted, #9ca3af)', marginBottom: 14 }}>
                Each toggle applies to this device only.
              </div>
              {EVENT_DESCRIPTORS.map((ev) => (
                <div
                  key={ev.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 0',
                    borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.05))',
                    gap: 24,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{ev.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted, #9ca3af)', marginTop: 2 }}>
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
          </Card>

          {/* Test push (admin only) */}
          {isAdmin && (
            <>
              <div style={{ height: 14 }} />
              <Card>
                <div
                  style={{
                    padding: 18,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>Send a test notification</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted, #9ca3af)', marginTop: 2 }}>
                      Fires a test push to every one of your devices that's enabled.
                    </div>
                    {testFlash && (
                      <div style={{ fontSize: 12, color: 'var(--clutch-green, #4ade80)', marginTop: 6 }}>
                        {testFlash}
                      </div>
                    )}
                  </div>
                  <Button variant="ghost" onClick={handleSendTest}>
                    Send test
                  </Button>
                </div>
              </Card>
            </>
          )}
        </>
      )}

      {/* Device list */}
      {subs.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Your subscribed devices</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted, #9ca3af)', marginBottom: 14 }}>
                {subs.length} device{subs.length === 1 ? '' : 's'} will receive your notifications.
              </div>
              {subs.map((s) => {
                const isThis = pushStatus?.endpoint === s.endpoint;
                return (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 0',
                      borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.05))',
                      gap: 16,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
                        {summariseUserAgent(s.user_agent)}
                        {isThis && <Badge variant="info">this device</Badge>}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--fg-dim, #6b7280)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>
                        Added {formatTimeAgo(s.created_at)}
                        {s.last_notified_at ? ` · last notified ${formatTimeAgo(s.last_notified_at)}` : ''}
                      </div>
                    </div>
                    {!isThis && (
                      <Button
                        variant="ghost"
                        disabled={working}
                        onClick={() => handleRemoveDevice(s.endpoint)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </div>
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
        border: 'none',
        background: on ? 'var(--clutch-green, #4ade80)' : 'var(--bg-elevated, #2a2d3b)',
        cursor: 'pointer',
        transition: 'background 120ms',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 18 : 2,
          width: 18,
          height: 18,
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
