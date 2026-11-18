/**
 * ViewsDialog: the live views of one broadcast day, for checking before
 * anyone ticks "Include views" on an export.
 *
 * Clean by default: the total, one status line and a plain list of channels.
 * What a number is based on sits behind the question mark and the "Details"
 * switch. An editor can run the collector now or enter a number handed over
 * by the channel owner (the TikTok LIVE Center card, a Twitch Stream Summary).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '@/services/api';
import { Row, Col, IconX, InfoTip, PlatformPip } from '@/components/design';
import { getPlatform } from '@/design/platforms';

export interface ViewsDialogProps {
  open: boolean;
  onClose: () => void;
  dayId: string | null;
  dayLabel: string;
}

const SOURCE_LABEL: Record<string, string> = {
  youtube_public: 'YouTube counter',
  youtube_live: 'YouTube live readings',
  youtube_analytics: 'YouTube Analytics',
  twitch_vod: 'Twitch archive',
  soop_vod: 'SOOP replay',
  tiktok_livecenter: 'TikTok LIVE Center',
  twitch_stream_summary: 'Twitch Stream Summary',
  csv_import: 'Imported',
  estimate: 'Estimate',
};

const fmt = (n: number) => n.toLocaleString('en-US');

export function ViewsDialog({ open, onClose, dayId, dayLabel }: ViewsDialogProps) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getDayViews>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [mChannel, setMChannel] = useState('');
  const [mSource, setMSource] = useState<api.ManualViewsEntry['source']>('tiktok_livecenter');
  const [mViews, setMViews] = useState('');
  const [mNote, setMNote] = useState('');

  const load = useCallback(async () => {
    if (!dayId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api.getDayViews(dayId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load views');
    } finally {
      setLoading(false);
    }
  }, [dayId]);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setNotice(null);
    setDetails(false);
    setManualOpen(false);
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const channels = data?.summary.channels ?? [];
  const totals = data?.summary.totals;
  const passes = useMemo(() => new Set((data?.runs ?? []).map((r) => r.snapshot)), [data]);
  // A LIVE Center card belongs to a TikTok channel, a Stream Summary to a Twitch one.
  const manualPlatform = mSource === 'tiktok_livecenter' ? 'tiktok' : mSource === 'twitch_stream_summary' ? 'twitch' : null;
  const manualChannels = manualPlatform ? channels.filter((c) => c.platform === manualPlatform) : channels;

  if (!open) return null;

  const status =
    channels.length === 0
      ? 'Not collected yet'
      : passes.has('plus_36h') || passes.has('plus_7d')
        ? 'Collected'
        : 'Collected so far. Twitch views arrive about 36 hours after the stream.';

  const collect = async () => {
    if (!dayId || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.collectDayViews(dayId);
      setNotice('Collected.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Collect failed');
    } finally {
      setBusy(false);
    }
  };

  const submitManual = async () => {
    if (!dayId || busy) return;
    const views = Number(mViews.replace(/[\s,.]/g, ''));
    if (!mChannel || !Number.isFinite(views) || views < 0 || mViews.trim() === '') {
      setError('Pick a channel and enter the views as a number');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.importDayViews(dayId, [{ channelId: mChannel, source: mSource, views, note: mNote.trim() || undefined }]);
      setNotice('Saved.');
      setMViews('');
      setMNote('');
      setManualOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const th: React.CSSProperties = {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--fg-dim)',
    padding: '0 6px 6px',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    fontWeight: 500,
  };
  const td: React.CSSProperties = { padding: '7px 6px', fontSize: 12.5, borderTop: '1px solid var(--border-faint)', verticalAlign: 'middle' };
  const input: React.CSSProperties = {
    padding: '6px 8px',
    fontSize: 12,
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--fg)',
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'color-mix(in oklab, var(--bg) 60%, rgba(0,0,0,0.55))',
        backdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: details ? 860 : 560, maxWidth: '100%', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 0 }}
      >
        <Row justify="space-between" style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-faint)' }}>
          <Col gap={2}>
            <span className="eyebrow" style={{ fontSize: 9.5 }}>Live views</span>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{dayLabel}</span>
          </Col>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">
            <IconX size={12} />
          </button>
        </Row>

        <div style={{ padding: '16px 22px', overflowY: 'auto' }}>
          <Row justify="space-between" style={{ alignItems: 'flex-end', marginBottom: 14, flexWrap: 'wrap', rowGap: 10 }}>
            <Col gap={2}>
              <Row gap={8} style={{ alignItems: 'center' }}>
                <span className="tabular" style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>
                  {totals && totals.liveViews > 0 ? fmt(totals.liveViews) : '–'}
                </span>
                <InfoTip label="About live views" lines={data?.summary.info ?? []} align="left" />
              </Row>
              <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{loading ? 'Loading…' : status}</span>
            </Col>
            <Row gap={8}>
              <button type="button" className="btn" onClick={collect} disabled={busy || !dayId}>
                {busy ? 'Working…' : 'Collect now'}
              </button>
              <button type="button" className="btn" onClick={() => setManualOpen((v) => !v)} disabled={busy || channels.length === 0}>
                Add manually
              </button>
            </Row>
          </Row>

          {notice && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginBottom: 10 }}>{notice}</div>}
          {error && (
            <div role="alert" style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 10 }}>
              {error}
            </div>
          )}

          {manualOpen && (
            <div style={{ padding: 12, border: '1px solid var(--border-faint)', borderRadius: 6, background: 'var(--bg-sunken)', marginBottom: 14 }}>
              <Row gap={8} wrap align="center">
                <select
                  value={mSource}
                  onChange={(e) => {
                    setMSource(e.target.value as api.ManualViewsEntry['source']);
                    setMChannel('');
                  }}
                  style={input}
                  aria-label="Source"
                >
                  <option value="tiktok_livecenter">TikTok LIVE Center (Total views)</option>
                  <option value="twitch_stream_summary">Twitch Stream Summary</option>
                  <option value="csv_import">Other number from the channel owner</option>
                </select>
                <select value={mChannel} onChange={(e) => setMChannel(e.target.value)} style={{ ...input, minWidth: 180 }} aria-label="Channel">
                  <option value="">Pick a channel…</option>
                  {manualChannels.map((c) => (
                    <option key={c.channelId} value={c.channelId}>
                      {c.displayName} · {getPlatform(c.platform)?.name ?? c.platform}
                    </option>
                  ))}
                </select>
                <input value={mViews} onChange={(e) => setMViews(e.target.value)} placeholder="Views" inputMode="numeric" style={{ ...input, width: 110 }} aria-label="Views" />
                <input value={mNote} onChange={(e) => setMNote(e.target.value)} placeholder="Note (optional)" style={{ ...input, flex: 1, minWidth: 120 }} aria-label="Note" />
                <button type="button" className="btn btn-primary" onClick={submitManual} disabled={busy}>
                  Save
                </button>
              </Row>
            </div>
          )}

          {channels.length > 0 && (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Channel</th>
                    <th style={th}>Platform</th>
                    <th style={{ ...th, textAlign: 'right' }}>Live views</th>
                    {details && <th style={{ ...th, paddingLeft: 18 }}>Based on</th>}
                    {details && <th style={th}>Note</th>}
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.channelId}>
                      <td style={{ ...td, fontWeight: 600 }}>
                        <Row gap={8} style={{ minWidth: 0 }}>
                          <PlatformPip id={c.platform} />
                          <span>{c.displayName}</span>
                        </Row>
                      </td>
                      <td style={{ ...td, color: 'var(--fg-muted)', fontSize: 11.5 }}>{getPlatform(c.platform)?.name ?? c.platform}</td>
                      <td
                        className="tabular"
                        style={{ ...td, textAlign: 'right', color: c.confidence === 'estimated' ? 'var(--fg-muted)' : 'var(--fg)' }}
                        title={c.confidence === 'estimated' ? 'Estimated from watch time' : undefined}
                      >
                        {fmt(c.liveViews)}
                      </td>
                      {details && (
                        <td style={{ ...td, paddingLeft: 18, color: 'var(--fg-muted)', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                          {c.sources.map((x) => SOURCE_LABEL[x] ?? x).join(', ')}
                        </td>
                      )}
                      {details && <td style={{ ...td, color: 'var(--fg-dim)', fontSize: 11, maxWidth: 300 }}>{c.note ?? ''}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => setDetails((v) => !v)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11.5, color: 'var(--fg-muted)' }}
                >
                  {details ? 'Hide details' : 'Details'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
