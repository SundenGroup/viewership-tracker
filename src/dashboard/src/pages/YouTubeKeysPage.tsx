/**
 * Settings → YouTube API Keys (admin only).
 *
 * Manages the key pool used by the YouTube discovery path. Each key is
 * tagged with a partner string (typically matching tournament_series.partner
 * — e.g. "PUBG", "PGL", "GeoGuessr"). A partner can have multiple keys; the
 * adapter routes each discovery search to the partner's pool first, falling
 * back to shared (partner=NULL) keys, then to no key.
 *
 * Admin-only — authenticated routes guard the page in App.tsx; this
 * component additionally checks role and renders a friendly fallback.
 */

import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Modal, FormField, Select, TextInput } from '@/components/common';
import { SettingsShell } from '@/components/design';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
import * as api from '@/services/api';
import type {
  YouTubeApiKey,
  YouTubeQuotaResponse,
  CreateYouTubeApiKey,
} from '@/types/api';
import { formatNumber, formatTimeAgo } from '@/utils/formatters';

const PARTNER_NULL_TOKEN = '__shared__';

interface KeyForm {
  label: string;
  partner: string; // empty string = shared
  secret: string;
  daily_quota: number;
}

const EMPTY_FORM: KeyForm = {
  label: '',
  partner: '',
  secret: '',
  daily_quota: 10000,
};

export function YouTubeKeysPage() {
  const { user } = useAuth();

  const { data, loading, error, refetch } = useApi<{ keys: YouTubeApiKey[] }>(
    () => api.listYouTubeKeys(true),
    [],
  );
  const [quota, setQuota] = useState<YouTubeQuotaResponse | null>(null);

  // ── Fetch quota on mount + every 30s ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const q = await api.getYouTubeQuotaDetailed();
        if (!cancelled) setQuota(q);
      } catch {
        // non-fatal
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ── Modals ─────────────────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<KeyForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editKey, setEditKey] = useState<YouTubeApiKey | null>(null);
  const [editForm, setEditForm] = useState<KeyForm>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // ── Existing partners for the dropdown (free-text + autocomplete) ─────
  const knownPartners = useMemo(() => {
    const set = new Set<string>();
    for (const k of data?.keys ?? []) {
      if (k.partner) set.add(k.partner);
    }
    return Array.from(set).sort();
  }, [data]);

  // ── Per-partner aggregates from quota response ────────────────────────
  const usageByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const k of quota?.perKey ?? []) map.set(k.id, k.used);
    return map;
  }, [quota]);

  // ── Group keys by partner for display ──────────────────────────────────
  const grouped = useMemo(() => {
    const groups = new Map<string, YouTubeApiKey[]>();
    for (const k of data?.keys ?? []) {
      const key = k.partner ?? PARTNER_NULL_TOKEN;
      const arr = groups.get(key) ?? [];
      arr.push(k);
      groups.set(key, arr);
    }
    return Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === PARTNER_NULL_TOKEN) return 1;
      if (b[0] === PARTNER_NULL_TOKEN) return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [data]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!createForm.label.trim() || !createForm.secret.trim()) {
      setCreateError('Label and key are required');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const payload: CreateYouTubeApiKey = {
        label: createForm.label.trim(),
        partner: createForm.partner.trim() || null,
        secret: createForm.secret.trim(),
        daily_quota: createForm.daily_quota,
      };
      await api.createYouTubeKey(payload);
      setCreateOpen(false);
      setCreateForm(EMPTY_FORM);
      refetch();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to add key');
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async () => {
    if (!editKey) return;
    setEditing(true);
    setEditError(null);
    try {
      await api.updateYouTubeKey(editKey.id, {
        label: editForm.label.trim(),
        partner: editForm.partner.trim() || null,
        daily_quota: editForm.daily_quota,
        ...(editForm.secret.trim() ? { secret: editForm.secret.trim() } : {}),
      });
      setEditKey(null);
      refetch();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update key');
    } finally {
      setEditing(false);
    }
  };

  const handleToggleActive = async (k: YouTubeApiKey) => {
    try {
      await api.updateYouTubeKey(k.id, { is_active: !k.is_active });
      refetch();
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (k: YouTubeApiKey) => {
    if (!window.confirm(`Soft-delete "${k.label}"? It can be re-enabled later via the database.`)) return;
    try {
      await api.deleteYouTubeKey(k.id);
      refetch();
    } catch {
      /* ignore */
    }
  };

  if (user?.role !== 'admin') {
    return (
      <SettingsShell breadcrumb="Settings · YouTube API keys" title="YouTube discovery key pool">
        <div style={{ padding: 32 }}>
          <Card>
            <p style={{ fontSize: 14, color: 'var(--fg-muted, #9ca3af)' }}>
              YouTube API keys are admin-only.
            </p>
          </Card>
        </div>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell breadcrumb="Settings · YouTube API keys" title="YouTube discovery key pool">
    <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <div className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-dim, #6b7280)', marginBottom: 4 }}>
            SETTINGS · API KEYS
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>YouTube discovery key pool</h1>
          <p style={{ fontSize: 13, color: 'var(--fg-muted, #9ca3af)', marginTop: 6, maxWidth: 720 }}>
            Tag each key with the partner it belongs to (PUBG, PGL, GeoGuessr…). Discovery searches for that
            partner's series will use that pool first; if it's exhausted, the search falls back to shared
            (unpartnered) keys, then to no API call. Polling uses a separate path and is not affected by these keys.
          </p>
        </div>
        <Button variant="primary" onClick={() => { setCreateForm(EMPTY_FORM); setCreateOpen(true); }}>
          + Add key
        </Button>
      </div>

      {/* Aggregate quota strip */}
      {quota && (
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, padding: 20 }}>
            <QuotaCell
              label="Discovery pool · today"
              used={quota.discoveryPool.used}
              limit={quota.discoveryPool.limit}
              accent="var(--clutch-red, #FF154D)"
            />
            <QuotaCell
              label="Polling key · today"
              used={quota.polling.used}
              limit={quota.polling.limit}
              accent="var(--accent-cyan, #38bdf8)"
            />
          </div>
        </Card>
      )}

      <div style={{ height: 18 }} />

      {loading && <Card><p style={{ padding: 20, color: 'var(--fg-muted)' }}>Loading…</p></Card>}
      {error && <Card><p style={{ padding: 20, color: 'var(--clutch-red)' }}>{error}</p></Card>}

      {!loading && !error && grouped.length === 0 && (
        <Card>
          <p style={{ padding: 24, color: 'var(--fg-muted)', fontSize: 13 }}>
            No keys yet. Click <strong>+ Add key</strong> to add the first one. The legacy
            <code style={{ background: 'var(--bg-card, #141820)', padding: '1px 6px', borderRadius: 4 }}>
              YOUTUBE_API_KEY
            </code> env var (if set) is auto-imported on first boot.
          </p>
        </Card>
      )}

      {grouped.map(([partnerKey, keys]) => {
        const partnerLabel = partnerKey === PARTNER_NULL_TOKEN ? 'Shared / fallback' : partnerKey;
        const partnerAgg = quota?.byPartner.find(
          (p) => (p.partner ?? PARTNER_NULL_TOKEN) === partnerKey,
        );
        return (
          <div key={partnerKey} style={{ marginBottom: 18 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{partnerLabel}</h2>
              {partnerAgg && (
                <div style={{ fontSize: 11.5, color: 'var(--fg-dim, #6b7280)', fontFamily: 'var(--font-mono)' }}>
                  {formatNumber(partnerAgg.used)} / {formatNumber(partnerAgg.limit)} used today · {keys.length} key{keys.length === 1 ? '' : 's'}
                </div>
              )}
            </div>
            <Card>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border, rgba(255,255,255,0.1))' }}>
                    <Th>Label</Th>
                    <Th>Key preview</Th>
                    <Th align="right">Used today</Th>
                    <Th align="right">Daily quota</Th>
                    <Th>Last used</Th>
                    <Th>Status</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const used = usageByKey.get(k.id) ?? 0;
                    const pct = k.daily_quota > 0 ? (used / k.daily_quota) * 100 : 0;
                    return (
                      <tr key={k.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <Td>
                          <div style={{ fontWeight: 500 }}>{k.label}</div>
                        </Td>
                        <Td>
                          <code style={{ fontSize: 12, color: 'var(--fg-muted, #9ca3af)' }}>
                            {k.secret_preview}
                          </code>
                        </Td>
                        <Td align="right">
                          <div className="tabular" style={{ fontFamily: 'var(--font-mono)' }}>
                            {formatNumber(used)}
                          </div>
                          <div
                            style={{
                              height: 3,
                              width: '100%',
                              background: 'rgba(255,255,255,0.08)',
                              borderRadius: 2,
                              overflow: 'hidden',
                              marginTop: 4,
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.min(100, pct)}%`,
                                height: '100%',
                                background: pct >= 90 ? 'var(--clutch-red, #FF154D)' : 'var(--accent-cyan, #38bdf8)',
                              }}
                            />
                          </div>
                        </Td>
                        <Td align="right">
                          <div className="tabular" style={{ fontFamily: 'var(--font-mono)' }}>
                            {formatNumber(k.daily_quota)}
                          </div>
                        </Td>
                        <Td>
                          <span style={{ fontSize: 11.5, color: 'var(--fg-muted, #9ca3af)' }}>
                            {k.last_used_at ? formatTimeAgo(k.last_used_at) : '—'}
                          </span>
                        </Td>
                        <Td>
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: 600,
                              padding: '2px 8px',
                              borderRadius: 4,
                              background: k.is_active ? 'rgba(38,189,248,0.18)' : 'rgba(255,255,255,0.08)',
                              color: k.is_active ? 'var(--accent-cyan, #38bdf8)' : 'var(--fg-muted, #9ca3af)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.06em',
                            }}
                          >
                            {k.is_active ? 'Active' : 'Disabled'}
                          </span>
                        </Td>
                        <Td align="right">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setEditKey(k);
                              setEditForm({
                                label: k.label,
                                partner: k.partner ?? '',
                                secret: '',
                                daily_quota: k.daily_quota,
                              });
                              setEditError(null);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleToggleActive(k)}
                            style={{ marginLeft: 6 }}
                          >
                            {k.is_active ? 'Disable' : 'Enable'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(k)}
                            style={{ marginLeft: 6, color: 'var(--clutch-red, #FF154D)' }}
                          >
                            Delete
                          </Button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </div>
        );
      })}

      {/* Create modal */}
      {createOpen && (
        <Modal open title="Add YouTube API key" onClose={() => setCreateOpen(false)}>
          <FormField label="Label">
            <TextInput
              value={createForm.label}
              onChange={(e) => setCreateForm({ ...createForm, label: e.target.value })}
              placeholder="e.g. PUBG · primary"
            />
          </FormField>
          <FormField label="Partner (optional — leave blank for a shared/fallback key)">
            <TextInput
              value={createForm.partner}
              onChange={(e) => setCreateForm({ ...createForm, partner: e.target.value })}
              list="known-partners"
              placeholder="e.g. PUBG"
            />
            <datalist id="known-partners">
              {knownPartners.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </FormField>
          <FormField label="API key">
            <TextInput
              value={createForm.secret}
              onChange={(e) => setCreateForm({ ...createForm, secret: e.target.value })}
              placeholder="AIzaSy…"
              type="password"
            />
          </FormField>
          <FormField label="Daily quota (default 10000)">
            <TextInput
              value={String(createForm.daily_quota)}
              onChange={(e) => setCreateForm({ ...createForm, daily_quota: parseInt(e.target.value, 10) || 0 })}
              type="number"
            />
          </FormField>
          {createError && (
            <p style={{ color: 'var(--clutch-red, #FF154D)', fontSize: 12, marginTop: 6 }}>{createError}</p>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} loading={creating}>Add key</Button>
          </div>
        </Modal>
      )}

      {/* Edit modal */}
      {editKey && (
        <Modal open title={`Edit "${editKey.label}"`} onClose={() => setEditKey(null)}>
          <FormField label="Label">
            <TextInput
              value={editForm.label}
              onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
            />
          </FormField>
          <FormField label="Partner (blank = shared/fallback)">
            <TextInput
              value={editForm.partner}
              onChange={(e) => setEditForm({ ...editForm, partner: e.target.value })}
              list="known-partners"
            />
          </FormField>
          <FormField label="Daily quota">
            <TextInput
              value={String(editForm.daily_quota)}
              onChange={(e) => setEditForm({ ...editForm, daily_quota: parseInt(e.target.value, 10) || 0 })}
              type="number"
            />
          </FormField>
          <FormField label="Replace API key (leave blank to keep current)">
            <TextInput
              value={editForm.secret}
              onChange={(e) => setEditForm({ ...editForm, secret: e.target.value })}
              type="password"
              placeholder="AIzaSy…"
            />
          </FormField>
          {editError && (
            <p style={{ color: 'var(--clutch-red, #FF154D)', fontSize: 12, marginTop: 6 }}>{editError}</p>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setEditKey(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleEdit} loading={editing}>Save</Button>
          </div>
        </Modal>
      )}
    </div>
    </SettingsShell>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      style={{
        textAlign: align,
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--fg-dim, #6b7280)',
        padding: '12px 14px',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td style={{ textAlign: align, padding: '14px', verticalAlign: 'middle' }}>{children}</td>
  );
}

function QuotaCell({
  label,
  used,
  limit,
  accent,
}: {
  label: string;
  used: number;
  limit: number;
  accent: string;
}) {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  return (
    <div>
      <div className="eyebrow" style={{ fontSize: 10, color: 'var(--fg-dim, #6b7280)', marginBottom: 6 }}>
        {label}
      </div>
      <div
        className="tabular"
        style={{ fontSize: 28, fontWeight: 500, fontFamily: 'var(--font-mono)', letterSpacing: '-0.02em' }}
      >
        {formatNumber(used)} <span style={{ fontSize: 14, color: 'var(--fg-dim, #6b7280)' }}>/ {formatNumber(limit)}</span>
      </div>
      <div
        style={{
          height: 5,
          width: '100%',
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 3,
          overflow: 'hidden',
          marginTop: 8,
        }}
      >
        <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: accent }} />
      </div>
    </div>
  );
}
