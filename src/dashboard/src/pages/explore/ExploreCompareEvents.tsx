/**
 * ExploreCompareEvents — two series, day-aligned.
 *
 * The question every event ends with: "how did this do against the last
 * one?" Both series' report payloads already carry per-broadcast-day
 * peak/avg/hours, so this is a pure read: align Day 1..N by index, show
 * the curves and the deltas. No backend work, no new metrics — the same
 * numbers the partner reports print.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/services/api';
import type { ReportPayload, TournamentSeries } from '@/types/api';
import { Row, Col, Section, LoadingBlock, EmptyState } from '@/components/design';
import { fmtCompact, fmtN } from '@/design/format';
import { downloadCsv, csvStamp } from '@/utils/csv';

interface DayRow {
  idx: number;
  a: ReportPayload['metrics'][number] | null;
  b: ReportPayload['metrics'][number] | null;
  aLabel: string | null;
  bLabel: string | null;
}

const A_COLOR = 'var(--red)';
const B_COLOR = 'var(--info, #4A9EDA)';

export function ExploreCompareEvents() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [seriesList, setSeriesList] = useState<TournamentSeries[] | null>(null);
  const [aId, setAId] = useState(() => searchParams.get('a') ?? '');
  const [bId, setBId] = useState(() => searchParams.get('b') ?? '');
  const [aPayload, setAPayload] = useState<ReportPayload | null>(null);
  const [bPayload, setBPayload] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listSeries().then(setSeriesList).catch((e: Error) => setError(e.message));
  }, []);

  // Selection → URL so a comparison is shareable.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (aId) p.set('a', aId);
        else p.delete('a');
        if (bId) p.set('b', bId);
        else p.delete('b');
        return p;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aId, bId]);

  useEffect(() => {
    if (!aId || !bId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.getReportPayload({ scope: 'series', id: aId }),
      api.getReportPayload({ scope: 'series', id: bId }),
    ])
      .then(([a, b]) => {
        if (cancelled) return;
        setAPayload(a);
        setBPayload(b);
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  const ready = aPayload && bPayload && aId && bId && !loading;

  // Metrics arrive keyed by broadcastDayId; order them by the day list
  // (already chronological) and align by index — "Day 3 vs Day 3".
  const rows = useMemo<DayRow[]>(() => {
    if (!aPayload || !bPayload) return [];
    const order = (p: ReportPayload) => {
      const byId = new Map(p.metrics.map((m) => [m.broadcastDayId, m]));
      return p.broadcastDays.map((d) => ({ metric: byId.get(d.id) ?? null, label: d.label }));
    };
    const a = order(aPayload);
    const b = order(bPayload);
    const n = Math.max(a.length, b.length);
    const out: DayRow[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        idx: i + 1,
        a: a[i]?.metric ?? null,
        b: b[i]?.metric ?? null,
        aLabel: a[i]?.label ?? null,
        bLabel: b[i]?.label ?? null,
      });
    }
    return out;
  }, [aPayload, bPayload]);

  const totals = useMemo(() => {
    const sum = (p: ReportPayload | null) => {
      const ms = p?.metrics ?? [];
      return {
        peak: ms.reduce((m, x) => Math.max(m, x.peakCCV), 0),
        hours: ms.reduce((s, x) => s + x.totalViewedHours, 0),
        days: ms.length,
      };
    };
    return { a: sum(aPayload), b: sum(bPayload) };
  }, [aPayload, bPayload]);

  const deltaPct = (a: number, b: number) =>
    b > 0 ? Math.round(((a - b) / b) * 100) : null;

  const exportCsv = () => {
    if (!ready) return;
    downloadCsv(
      `compare-${aPayload.series.shortName ?? 'a'}-vs-${bPayload.series.shortName ?? 'b'}-${csvStamp()}.csv`,
      ['day', 'a_label', 'a_peak', 'a_avg', 'a_hours_watched', 'b_label', 'b_peak', 'b_avg', 'b_hours_watched', 'peak_delta_pct'],
      rows.map((r) => [
        r.idx,
        r.aLabel,
        r.a?.peakCCV ?? null,
        r.a ? Math.round(r.a.avgCCV) : null,
        r.a ? Math.round(r.a.totalViewedHours) : null,
        r.bLabel,
        r.b?.peakCCV ?? null,
        r.b ? Math.round(r.b.avgCCV) : null,
        r.b ? Math.round(r.b.totalViewedHours) : null,
        r.a && r.b ? deltaPct(r.a.peakCCV, r.b.peakCCV) : null,
      ]),
    );
  };

  const seriesName = (p: ReportPayload | null, fallback: string) =>
    p?.series.shortName || p?.series.name || fallback;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 80px' }}>
      <Col gap={16}>
        <Col gap={4}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>
            Compare events
          </h1>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0 }}>
            Two series, aligned day by day — same numbers as the partner reports.
          </p>
        </Col>

        <Row gap={10} align="center" wrap>
          <SeriesPicker
            label="Event A"
            color={A_COLOR}
            value={aId}
            onChange={setAId}
            seriesList={seriesList ?? []}
            excludeId={bId}
          />
          <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}>vs</span>
          <SeriesPicker
            label="Event B"
            color={B_COLOR}
            value={bId}
            onChange={setBId}
            seriesList={seriesList ?? []}
            excludeId={aId}
          />
          {ready && (
            <button type="button" className="btn btn-xs" onClick={exportCsv} style={{ marginLeft: 'auto', cursor: 'pointer' }}>
              CSV
            </button>
          )}
        </Row>

        {error && <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>}
        {loading && <LoadingBlock />}
        {!aId || !bId ? (
          <EmptyState minHeight={200}>Pick two events to compare their day-by-day performance.</EmptyState>
        ) : null}

        {ready && (
          <>
            {/* Headline totals */}
            <Row gap={12} wrap style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <TotalCard
                title={seriesName(aPayload, 'Event A')}
                color={A_COLOR}
                peak={totals.a.peak}
                hours={totals.a.hours}
                days={totals.a.days}
              />
              <TotalCard
                title={seriesName(bPayload, 'Event B')}
                color={B_COLOR}
                peak={totals.b.peak}
                hours={totals.b.hours}
                days={totals.b.days}
                deltaVs={{ peak: totals.a.peak, hours: totals.a.hours }}
              />
            </Row>

            {/* Day-peak curves, aligned by day index */}
            <Section title="Peak by day" eyebrow="ALIGNED">
              <DayCurves rows={rows} aName={seriesName(aPayload, 'A')} bName={seriesName(bPayload, 'B')} />
            </Section>

            {/* Day table */}
            <Section title="Day by day" eyebrow="DETAIL" compact>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 720 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={th}>Day</th>
                      <th style={{ ...th, color: A_COLOR }}>{seriesName(aPayload, 'A')}</th>
                      <th style={{ ...th, textAlign: 'right' }}>Peak</th>
                      <th style={{ ...th, textAlign: 'right' }}>Avg</th>
                      <th style={{ ...th, textAlign: 'right' }}>Hours</th>
                      <th style={{ ...th, color: B_COLOR, paddingLeft: 18 }}>{seriesName(bPayload, 'B')}</th>
                      <th style={{ ...th, textAlign: 'right' }}>Peak</th>
                      <th style={{ ...th, textAlign: 'right' }}>Avg</th>
                      <th style={{ ...th, textAlign: 'right' }}>Hours</th>
                      <th style={{ ...th, textAlign: 'right' }} title="Event A peak vs Event B peak, same day number">
                        Δ peak
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const d = r.a && r.b ? deltaPct(r.a.peakCCV, r.b.peakCCV) : null;
                      return (
                        <tr key={r.idx} style={{ borderBottom: '1px solid var(--border-faint)' }}>
                          <td style={{ ...td, color: 'var(--fg-muted)' }}>Day {r.idx}</td>
                          <td style={{ ...td, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.aLabel ?? '—'}
                          </td>
                          <td style={num}>{r.a ? fmtCompact(r.a.peakCCV) : '—'}</td>
                          <td style={num}>{r.a ? fmtCompact(Math.round(r.a.avgCCV)) : '—'}</td>
                          <td style={num}>{r.a ? fmtCompact(Math.round(r.a.totalViewedHours)) : '—'}</td>
                          <td style={{ ...td, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: 18 }}>
                            {r.bLabel ?? '—'}
                          </td>
                          <td style={num}>{r.b ? fmtCompact(r.b.peakCCV) : '—'}</td>
                          <td style={num}>{r.b ? fmtCompact(Math.round(r.b.avgCCV)) : '—'}</td>
                          <td style={num}>{r.b ? fmtCompact(Math.round(r.b.totalViewedHours)) : '—'}</td>
                          <td style={{ ...num, color: d == null ? 'var(--fg-dim)' : d >= 0 ? 'var(--live)' : 'var(--danger)' }}>
                            {d == null ? '—' : `${d > 0 ? '+' : ''}${d}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        )}
      </Col>
    </div>
  );
}

function SeriesPicker({
  label,
  color,
  value,
  onChange,
  seriesList,
  excludeId,
}: {
  label: string;
  color: string;
  value: string;
  onChange: (id: string) => void;
  seriesList: TournamentSeries[];
  excludeId?: string;
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--fg-muted)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '6px 9px',
          fontSize: 12.5,
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--bg-sunken)',
          color: 'var(--fg)',
          maxWidth: 240,
        }}
      >
        <option value="">Pick a series…</option>
        {seriesList
          .filter((s) => s.id !== excludeId)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.short_name || s.name}
            </option>
          ))}
      </select>
    </label>
  );
}

function TotalCard({
  title,
  color,
  peak,
  hours,
  days,
  deltaVs,
}: {
  title: string;
  color: string;
  peak: number;
  hours: number;
  days: number;
  deltaVs?: { peak: number; hours: number };
}) {
  const d = deltaVs && peak > 0 ? Math.round(((deltaVs.peak - peak) / peak) * 100) : null;
  return (
    <div className="card" style={{ padding: 16, borderTop: `2px solid ${color}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      <Row gap={18} wrap style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        <span>
          <b style={{ color: 'var(--fg)', fontSize: 16 }}>{fmtCompact(peak)}</b>
          <br />
          event peak
        </span>
        <span>
          <b style={{ color: 'var(--fg)', fontSize: 16 }}>{fmtCompact(Math.round(hours))}</b>
          <br />
          hours watched
        </span>
        <span>
          <b style={{ color: 'var(--fg)', fontSize: 16 }}>{fmtN(days)}</b>
          <br />
          broadcast days
        </span>
        {d != null && (
          <span title="Event A's peak vs this event's peak">
            <b style={{ color: d >= 0 ? 'var(--live)' : 'var(--danger)', fontSize: 16 }}>
              {d > 0 ? '+' : ''}
              {d}%
            </b>
            <br />
            A vs B peak
          </span>
        )}
      </Row>
    </div>
  );
}

/** Two aligned day-peak polylines — day index on X so events overlay. */
function DayCurves({ rows, aName, bName }: { rows: DayRow[]; aName: string; bName: string }) {
  const W = 640;
  const H = 180;
  const PAD = 8;
  const max = Math.max(1, ...rows.flatMap((r) => [r.a?.peakCCV ?? 0, r.b?.peakCCV ?? 0]));
  const x = (i: number) => PAD + (i / Math.max(rows.length - 1, 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const line = (pick: (r: DayRow) => number | null) =>
    rows
      .map((r, i) => {
        const v = pick(r);
        return v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');

  return (
    <Col gap={8}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Day-aligned peak comparison">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD} x2={W - PAD} y1={y(max * f)} y2={y(max * f)} stroke="var(--border-faint)" strokeDasharray="3 3" />
        ))}
        <polyline points={line((r) => r.a?.peakCCV ?? null)} fill="none" stroke={A_COLOR} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <polyline points={line((r) => r.b?.peakCCV ?? null)} fill="none" stroke={B_COLOR} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {rows.map((r, i) => (
          <text key={r.idx} x={x(i)} y={H - 1} textAnchor="middle" fontSize={8} fill="var(--fg-dim)">
            {r.idx}
          </text>
        ))}
      </svg>
      <Row gap={16} style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 2, background: A_COLOR, verticalAlign: 'middle', marginRight: 5 }} />{aName}</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 2, background: B_COLOR, verticalAlign: 'middle', marginRight: 5 }} />{bName}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-dim)' }}>x-axis: day number</span>
      </Row>
    </Col>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 10.5,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--fg-muted)',
  padding: '6px 8px 6px 0',
  whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '7px 8px 7px 0', color: 'var(--fg)' };
const num: React.CSSProperties = {
  ...td,
  textAlign: 'right',
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
};
