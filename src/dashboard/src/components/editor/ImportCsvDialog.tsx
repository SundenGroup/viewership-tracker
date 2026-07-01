/**
 * ImportCsvDialog — replace a channel's viewership data for one broadcast
 * day from an official platform CSV export (Twitch "Stream Session",
 * YouTube analytics, or any time+viewers CSV).
 *
 * Two-step flow, mirroring how these imports were done manually during
 * PNC2026: Preview first (server parses the CSV and reports the covered
 * time range + how many existing rows would be replaced), then a separate
 * destructive confirm. The commit re-parses server-side with the same
 * inputs, so what you previewed is exactly what lands.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from '@/services/api';
import { Row, Col, IconX, IconArrowUp } from '@/components/design';
import type { SeriesWithStages } from '@/types/api';

export interface ImportCsvDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  seriesDetail: SeriesWithStages | null;
}

const COMMON_TIMEZONES = [
  'Europe/Berlin',
  'Europe/Stockholm',
  'UTC',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Asia/Bangkok',
];

export function ImportCsvDialog({
  open,
  onClose,
  seriesId,
  seriesDetail,
}: ImportCsvDialogProps) {
  const [channels, setChannels] = useState<
    Array<{ id: string; display_name: string; platform: string; channel_identifier: string }>
  >([]);
  const [channelSearch, setChannelSearch] = useState('');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [dayId, setDayId] = useState<string | null>(null);
  // Data source: an official platform CSV, or the Discover game-tracker
  // (per-minute Twitch/Kick category data — for cohost repair & gap fills).
  const [source, setSource] = useState<'csv' | 'discover'>('csv');
  const [mode, setMode] = useState<'replace' | 'fill-gaps'>('replace');
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [timezone, setTimezone] = useState('Europe/Berlin');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [preview, setPreview] = useState<api.CsvImportResult | null>(null);
  const [result, setResult] = useState<api.CsvImportResult | null>(null);
  const [dPreview, setDPreview] = useState<api.DiscoverBackfillResult | null>(null);
  const [dResult, setDResult] = useState<api.DiscoverBackfillResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setChannelSearch('');
      setChannelId(null);
      setDayId(null);
      setSource('csv');
      setMode('replace');
      setCsvText(null);
      setFileName(null);
      setDate('');
      setTimezone('Europe/Berlin');
      setStartTime('');
      setEndTime('');
      setPreview(null);
      setResult(null);
      setDPreview(null);
      setDResult(null);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  // Load channels (all — an import target may be inactive)
  useEffect(() => {
    if (!open || !seriesId) return;
    api
      .listChannels(seriesId)
      .then((rows) =>
        setChannels(
          rows
            .map((c) => ({
              id: c.id,
              display_name: c.display_name,
              platform: c.platform,
              channel_identifier: c.channel_identifier,
            }))
            // Twitch + YouTube first — the platforms with official CSV exports
            .sort((a, b) => {
              const rank = (p: string) => (p === 'twitch' ? 0 : p === 'youtube' ? 1 : 2);
              return rank(a.platform) - rank(b.platform) || a.display_name.localeCompare(b.display_name);
            }),
        ),
      )
      .catch(() => setChannels([]));
  }, [open, seriesId]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const allDays = useMemo(() => {
    if (!seriesDetail) return [];
    return seriesDetail.stages.flatMap((s) =>
      s.broadcast_days.map((d) => ({ ...d, stageName: s.name })),
    );
  }, [seriesDetail]);

  const selectedDay = allDays.find((d) => d.id === dayId) ?? null;
  const selectedChannel = channels.find((c) => c.id === channelId) ?? null;

  // Default the CSV date to the selected broadcast day's date
  useEffect(() => {
    if (selectedDay?.date) setDate(String(selectedDay.date).slice(0, 10));
  }, [selectedDay?.date]);

  // Any input change invalidates a previous preview/result
  const invalidate = () => {
    setPreview(null);
    setResult(null);
    setDPreview(null);
    setDResult(null);
    setError(null);
  };

  const handleFile = async (file: File | null) => {
    invalidate();
    if (!file) {
      setCsvText(null);
      setFileName(null);
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError('File too large (max 4MB)');
      return;
    }
    setCsvText(await file.text());
    setFileName(file.name);
  };

  const canPreview =
    !!channelId && !!dayId && !busy && (source === 'discover' || !!csvText);

  const run = async (dryRun: boolean) => {
    if (!channelId || !dayId) return;
    if (source === 'csv' && !csvText) return;
    setBusy(true);
    setError(null);
    try {
      if (source === 'csv') {
        const res = await api.importViewershipCsv({
          channelId,
          broadcastDayId: dayId,
          csvText: csvText!,
          date: date || undefined,
          timezone: timezone || undefined,
          startTime: startTime || undefined,
          endTime: endTime || undefined,
          dryRun,
        });
        if (dryRun) {
          setPreview(res);
        } else {
          setResult(res);
          setPreview(null);
        }
      } else {
        const res = await api.backfillFromDiscover({
          channelId,
          broadcastDayId: dayId,
          date: date || undefined,
          timezone: timezone || undefined,
          startTime: startTime || undefined,
          endTime: endTime || undefined,
          mode,
          dryRun,
        });
        if (dryRun) {
          setDPreview(res);
        } else {
          setDResult(res);
          setDPreview(null);
        }
      }
    } catch (err) {
      setError(
        err instanceof api.ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Import failed',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const filteredChannels = channels
    // The game-tracker only covers Twitch + Kick.
    .filter((c) => source !== 'discover' || c.platform === 'twitch' || c.platform === 'kick')
    .filter(
      (c) =>
        c.display_name.toLowerCase().includes(channelSearch.toLowerCase()) ||
        c.channel_identifier.toLowerCase().includes(channelSearch.toLowerCase()),
    )
    .slice(0, 40);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 9px',
    fontSize: 12,
    borderRadius: 5,
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
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
        style={{
          width: 640,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Header */}
        <Row
          justify="space-between"
          align="flex-start"
          style={{
            padding: '18px 22px 14px',
            borderBottom: '1px solid var(--border-faint)',
          }}
        >
          <Col gap={3} style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Import official CSV</h3>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Replace a channel's data for one broadcast day with a platform
              export (Twitch Stream Session / YouTube analytics).
            </div>
          </Col>
          <button
            onClick={onClose}
            className="btn"
            style={{ padding: 5, background: 'transparent', border: 'none' }}
            title="Close"
          >
            <IconX size={12} />
          </button>
        </Row>

        {/* Body */}
        <div style={{ padding: '18px 22px', overflow: 'auto', flex: 1 }}>
          <Col gap={16}>
            {/* Source picker */}
            <Field label="Data source">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {(
                  [
                    {
                      id: 'csv' as const,
                      label: 'Official CSV',
                      sub: 'Twitch Stream Session / YouTube analytics export',
                    },
                    {
                      id: 'discover' as const,
                      label: 'Discover game-tracker',
                      sub: 'Per-minute Helix data — cohost repair & gap fills',
                    },
                  ]
                ).map((s) => {
                  const active = source === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setSource(s.id);
                        invalidate();
                      }}
                      style={{
                        textAlign: 'left',
                        padding: '11px 13px',
                        borderRadius: 6,
                        background: active
                          ? 'color-mix(in oklab, var(--red) 10%, var(--bg-card))'
                          : 'var(--bg-card)',
                        border: '1px solid ' + (active ? 'var(--red)' : 'var(--border)'),
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        color: 'var(--fg)',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: active ? 'var(--red)' : 'var(--fg)',
                        }}
                      >
                        {s.label}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>{s.sub}</span>
                    </button>
                  );
                })}
              </div>
            </Field>

            {/* Channel picker */}
            <Field label={selectedChannel ? `Channel — ${selectedChannel.display_name}` : 'Channel'}>
              <input
                type="text"
                placeholder="Search channels…"
                value={channelSearch}
                onChange={(e) => setChannelSearch(e.target.value)}
                style={{ ...inputStyle, marginBottom: 8 }}
              />
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  maxHeight: 120,
                  overflowY: 'auto',
                }}
              >
                {filteredChannels.map((ch) => {
                  const active = channelId === ch.id;
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      title={`${ch.platform} · ${ch.channel_identifier}`}
                      onClick={() => {
                        setChannelId(active ? null : ch.id);
                        invalidate();
                      }}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 999,
                        fontSize: 11.5,
                        fontWeight: active ? 600 : 500,
                        background: active
                          ? 'color-mix(in oklab, var(--red) 14%, var(--bg-card))'
                          : 'var(--bg-card)',
                        color: active ? 'var(--red)' : 'var(--fg)',
                        border: '1px solid ' + (active ? 'var(--red)' : 'var(--border)'),
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ opacity: 0.55, marginRight: 5, fontSize: 10 }}>
                        {ch.platform}
                      </span>
                      {ch.display_name}
                    </button>
                  );
                })}
                {filteredChannels.length === 0 && (
                  <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>No matches.</span>
                )}
              </div>
            </Field>

            {/* Day + file */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Broadcast day">
                <select
                  value={dayId ?? ''}
                  onChange={(e) => {
                    setDayId(e.target.value || null);
                    invalidate();
                  }}
                  style={inputStyle}
                >
                  <option value="">Select day…</option>
                  {allDays.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.stageName} · {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              {source === 'csv' ? (
                <Field label={fileName ? `CSV file — ${fileName}` : 'CSV file'}>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                    style={{ ...inputStyle, padding: '5px 6px' }}
                  />
                </Field>
              ) : (
                <Field label="Backfill mode">
                  <select
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value as 'replace' | 'fill-gaps');
                      invalidate();
                    }}
                    style={inputStyle}
                  >
                    <option value="replace">Replace window (cohost/Helix repair)</option>
                    <option value="fill-gaps">Fill gaps only (crash recovery)</option>
                  </select>
                </Field>
              )}
            </div>

            {/* Date / timezone / bounds */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
              <Field label="CSV date">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    invalidate();
                  }}
                  style={inputStyle}
                />
              </Field>
              <Field label="Timezone of times">
                <input
                  type="text"
                  list="import-tz-options"
                  value={timezone}
                  onChange={(e) => {
                    setTimezone(e.target.value);
                    invalidate();
                  }}
                  style={inputStyle}
                />
                <datalist id="import-tz-options">
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </Field>
              <Field label="From (optional)">
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => {
                    setStartTime(e.target.value);
                    invalidate();
                  }}
                  style={inputStyle}
                />
              </Field>
              <Field label="To (optional)">
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => {
                    setEndTime(e.target.value);
                    invalidate();
                  }}
                  style={inputStyle}
                />
              </Field>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', marginTop: -8 }}>
              {source === 'csv'
                ? 'Times without a date in the CSV (e.g. Twitch\'s "10:30 AM") use the date above, interpreted in the selected timezone. "From/To" trims the import to a local-time window (e.g. start at 11:00).'
                : 'Leave From/To empty to cover the whole scheduled broadcast window. Set them (local time in the selected timezone, on the date above) to target a specific stretch — e.g. a 16:00–16:22 crash gap.'}
            </div>

            {/* Preview panel */}
            {preview && (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'color-mix(in oklab, var(--warning, orange) 7%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--warning, orange) 35%, var(--border))',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Preview — nothing written yet
                </div>
                <Col gap={4} style={{ fontSize: 11.5 }}>
                  <span>
                    Parsed <b>{preview.parsed}</b> rows
                    {preview.skipped > 0 ? ` (${preview.skipped} skipped)` : ''} for{' '}
                    <b>{preview.channel.displayName}</b> ({preview.channel.platform})
                  </span>
                  <span>
                    Range: <b>{preview.range.fromLocal}</b> → <b>{preview.range.toLocal}</b>{' '}
                    ({preview.timezone})
                  </span>
                  <span style={{ color: 'var(--danger)' }}>
                    Will DELETE {preview.existingRowsInRange} existing rows in this range on
                    "{preview.day.label}" and insert {preview.parsed} official values.
                  </span>
                  {preview.warnings.length > 0 && (
                    <span style={{ color: 'var(--fg-muted)' }}>
                      Warnings: {preview.warnings.join(' · ')}
                    </span>
                  )}
                  <span className="mono" style={{ color: 'var(--fg-dim)', fontSize: 10.5 }}>
                    first {preview.sample.first.map((p) => `${p.t.slice(11, 16)}→${p.v}`).join(', ')}{' '}
                    · last {preview.sample.last.map((p) => `${p.t.slice(11, 16)}→${p.v}`).join(', ')}
                  </span>
                </Col>
              </div>
            )}

            {/* Discover preview panel */}
            {dPreview && (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'color-mix(in oklab, var(--warning, orange) 7%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--warning, orange) 35%, var(--border))',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Preview — nothing written yet
                </div>
                <Col gap={4} style={{ fontSize: 11.5 }}>
                  <span>
                    {dPreview.source}: <b>{dPreview.trackerPoints}</b> per-minute points for{' '}
                    <b>{dPreview.channel.displayName}</b> ({dPreview.channel.platform})
                  </span>
                  <span>
                    Window: <b>{dPreview.range.fromLocal}</b> → <b>{dPreview.range.toLocal}</b>{' '}
                    ({dPreview.timezone})
                  </span>
                  {dPreview.mode === 'replace' ? (
                    <span style={{ color: 'var(--danger)' }}>
                      Will DELETE {dPreview.willDelete} existing rows in this window on
                      "{dPreview.day.label}" and insert {dPreview.willInsert} tracker values.
                    </span>
                  ) : (
                    <span>
                      Will fill <b>{dPreview.gapMinutes}</b> gap minutes (existing{' '}
                      {dPreview.existingRowsInRange} rows stay untouched).
                    </span>
                  )}
                  <span className="mono" style={{ color: 'var(--fg-dim)', fontSize: 10.5 }}>
                    first {dPreview.sample.first.map((p) => `${p.t.slice(11, 16)}→${p.v}`).join(', ')}{' '}
                    · last {dPreview.sample.last.map((p) => `${p.t.slice(11, 16)}→${p.v}`).join(', ')}
                  </span>
                </Col>
              </div>
            )}

            {/* Discover result panel */}
            {dResult && (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'color-mix(in oklab, var(--success, green) 8%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--success, green) 35%, var(--border))',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Backfill complete</div>
                <span style={{ fontSize: 11.5 }}>
                  {dResult.mode === 'replace'
                    ? `Replaced ${dResult.deleted} rows with ${dResult.inserted} tracker values`
                    : `Filled ${dResult.inserted} gap minutes`}{' '}
                  for {dResult.channel.displayName} on "{dResult.day.label}" (
                  {dResult.range.fromLocal} → {dResult.range.toLocal} {dResult.timezone}).
                </span>
              </div>
            )}

            {/* Result panel */}
            {result && (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'color-mix(in oklab, var(--success, green) 8%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--success, green) 35%, var(--border))',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Import complete</div>
                <span style={{ fontSize: 11.5 }}>
                  Replaced <b>{result.deleted}</b> rows with <b>{result.inserted}</b> official
                  values for {result.channel.displayName} on "{result.day.label}" (
                  {result.range.fromLocal} → {result.range.toLocal} {result.timezone}).
                </span>
              </div>
            )}

            {error && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 5,
                  background: 'color-mix(in oklab, var(--danger) 10%, transparent)',
                  border: '1px solid var(--danger)',
                  fontSize: 11.5,
                  color: 'var(--danger)',
                }}
              >
                {error}
              </div>
            )}
          </Col>
        </div>

        {/* Footer */}
        <Row
          gap={8}
          justify="flex-end"
          style={{
            padding: '14px 22px',
            borderTop: '1px solid var(--border-faint)',
            background: 'var(--bg-sunken)',
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              marginRight: 'auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {selectedChannel && selectedDay
              ? `${selectedChannel.platform}/${selectedChannel.channel_identifier} → ${selectedDay.label}`
              : 'Pick a channel, a day and a CSV file'}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {result || dResult ? 'Close' : 'Cancel'}
          </button>
          {!preview && !dPreview && !result && !dResult && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => run(true)}
              disabled={!canPreview}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <IconArrowUp size={12} />
              {busy ? 'Parsing…' : 'Preview'}
            </button>
          )}
          {(preview || dPreview) && !result && !dResult && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => run(false)}
              disabled={busy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {busy
                ? 'Importing…'
                : preview
                  ? `Replace ${preview.existingRowsInRange} rows`
                  : dPreview!.mode === 'replace'
                    ? `Replace ${dPreview!.willDelete} rows`
                    : `Fill ${dPreview!.gapMinutes} gap minutes`}
            </button>
          )}
        </Row>
      </div>
    </div>
  );
}

// ── Field wrapper (label + body) ──────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div
        className="eyebrow"
        style={{ fontSize: 9.5, marginBottom: 6, letterSpacing: 0.5 }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
