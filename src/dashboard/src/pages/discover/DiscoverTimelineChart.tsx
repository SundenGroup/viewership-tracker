import { useMemo, useRef, useState, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { fmtCompact, fmtN } from '@/design/format';

interface Bucket {
  ts: string;
  total_ccv: number;
  stream_count: number;
}

interface Selection {
  fromIso: string;
  toIso: string | null;
}

export interface EventWindow {
  name: string;
  start: string;
  end: string;
}

interface Props {
  buckets: Bucket[];
  height?: number;
  selection: Selection | null;
  onPick: (sel: Selection) => void;
  /** Range fetch in flight — dims the chart and blocks the empty state. */
  loading?: boolean;
  /** Official broadcast windows to shade behind the line ("was that spike PGS?"). */
  events?: EventWindow[];
}

const DRAG_THRESHOLD_PX = 6;
// Plot-area bounds for pointer→bucket mapping and the selection overlays.
// Must match the chart config below: margin.left 5 + YAxis width 50.
const PLOT_LEFT = 55;
const PLOT_RIGHT = 20;

/**
 * Overlay geometry. calc() cannot multiply a percentage by a length or
 * divide by a percentage — the previous `N% * (100% - 75px) / 100%` form
 * was silently dropped by the browser, pinning every overlay to the left
 * edge. length × number is the valid formulation.
 */
const plotX = (pct: number) =>
  `calc(${PLOT_LEFT}px + (100% - ${PLOT_LEFT + PLOT_RIGHT}px) * ${(pct / 100).toFixed(5)})`;
const plotW = (pct: number) =>
  `calc((100% - ${PLOT_LEFT + PLOT_RIGHT}px) * ${(pct / 100).toFixed(5)})`;

/**
 * Lightweight drag-to-select timeseries for Discover trends. Click a
 * point → emits {fromIso, toIso: null}. Drag → emits {fromIso, toIso}.
 *
 * Mirrors the InteractiveMainChart UX in spirit but keeps the surface
 * small: one series, one set of overlays, no scope/series complexity.
 */
export function DiscoverTimelineChart({ buckets, height = 280, selection, onPick, loading, events }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startIdx: number; currentIdx: number; startX: number } | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const xToIdx = useCallback(
    (clientX: number): number => {
      const el = containerRef.current;
      if (!el || buckets.length === 0) return 0;
      const rect = el.getBoundingClientRect();
      const usable = rect.width - PLOT_LEFT - PLOT_RIGHT;
      const x = Math.max(0, Math.min(usable, clientX - rect.left - PLOT_LEFT));
      const ratio = usable > 0 ? x / usable : 0;
      return Math.max(0, Math.min(buckets.length - 1, Math.round(ratio * (buckets.length - 1))));
    },
    [buckets.length],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (buckets.length === 0) return;
    const idx = xToIdx(e.clientX);
    setDrag({ startIdx: idx, currentIdx: idx, startX: e.clientX });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (buckets.length === 0) return;
    const idx = xToIdx(e.clientX);
    setHoverIdx(idx);
    if (drag) setDrag({ ...drag, currentIdx: idx });
  };

  const onPointerLeave = () => {
    setHoverIdx(null);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || buckets.length === 0) return;
    const dragDistance = Math.abs(e.clientX - drag.startX);
    if (dragDistance < DRAG_THRESHOLD_PX) {
      const start = buckets[drag.startIdx];
      if (start) onPick({ fromIso: start.ts, toIso: null });
    } else {
      const lo = Math.min(drag.startIdx, drag.currentIdx);
      const hi = Math.max(drag.startIdx, drag.currentIdx);
      const loBucket = buckets[lo];
      const hiBucket = buckets[hi];
      if (loBucket && hiBucket) onPick({ fromIso: loBucket.ts, toIso: hiBucket.ts });
    }
    setDrag(null);
  };

  const selectedAnchorIdx = useMemo(() => {
    if (!selection || buckets.length === 0) return null;
    const target = selection.fromIso;
    const idx = buckets.findIndex((b) => b.ts === target);
    return idx === -1 ? null : idx;
  }, [buckets, selection]);

  const selectedRange = useMemo(() => {
    if (!selection?.toIso || buckets.length === 0) return null;
    const fromIdx = buckets.findIndex((b) => b.ts === selection.fromIso);
    const toIdx = buckets.findIndex((b) => b.ts === selection.toIso);
    if (fromIdx === -1 || toIdx === -1) return null;
    return [Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx)] as const;
  }, [buckets, selection]);

  // Drag preview.
  const dragRange = drag
    ? ([Math.min(drag.startIdx, drag.currentIdx), Math.max(drag.startIdx, drag.currentIdx)] as const)
    : null;

  const idxToPercent = (idx: number) =>
    buckets.length > 1 ? (idx / (buckets.length - 1)) * 100 : 0;

  const spanHours = useMemo(() => {
    if (buckets.length < 2) return 0;
    return (Date.parse(buckets[buckets.length - 1]!.ts) - Date.parse(buckets[0]!.ts)) / 3600_000;
  }, [buckets]);

  // Event windows → bucket-index spans. Clamped to the visible window;
  // events entirely outside it vanish.
  const eventBands = useMemo(() => {
    if (!events?.length || buckets.length < 2) return [];
    const times = buckets.map((b) => Date.parse(b.ts));
    const first = times[0]!;
    const last = times[times.length - 1]!;
    const out: Array<{ name: string; lo: number; hi: number; start: string; end: string }> = [];
    for (const ev of events) {
      const s0 = Date.parse(ev.start);
      const e0 = Date.parse(ev.end);
      if (Number.isNaN(s0) || Number.isNaN(e0) || e0 <= first || s0 >= last) continue;
      let lo = times.findIndex((t) => t >= s0);
      if (lo === -1) lo = times.length - 1;
      let hi = times.length - 1;
      for (let i = times.length - 1; i >= 0; i--) {
        if (times[i]! <= e0) { hi = i; break; }
      }
      if (hi <= lo) hi = Math.min(lo + 1, times.length - 1);
      out.push({ name: ev.name, lo, hi, start: ev.start, end: ev.end });
    }
    return out;
  }, [events, buckets]);

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerUp={onPointerUp}
      style={{
        position: 'relative',
        width: '100%',
        height,
        cursor: drag ? 'grabbing' : 'crosshair',
        userSelect: 'none',
        // let vertical page-scroll gestures through on touch; horizontal
        // drags still select
        touchAction: 'pan-y',
        opacity: loading ? 0.45 : 1,
        transition: 'opacity 160ms',
      }}
    >
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            color: 'var(--fg-muted)',
            zIndex: 1,
          }}
        >
          Loading range…
        </div>
      )}
      {!loading && buckets.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            color: 'var(--fg-muted)',
          }}
        >
          No data in this range.
        </div>
      )}
      {/* Official broadcast windows — behind the plot, never interactive */}
      {eventBands.map((band, i) => {
        const loPct = idxToPercent(band.lo);
        const hiPct = idxToPercent(band.hi);
        const fmt = (iso: string) =>
          new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return (
          <div
            key={`${band.name}-${i}`}
            title={`${band.name} · ${fmt(band.start)} – ${fmt(band.end)}`}
            style={{
              position: 'absolute',
              top: 8,
              bottom: 24,
              left: plotX(loPct),
              width: plotW(Math.max(hiPct - loPct, 0.5)),
              background: 'color-mix(in oklab, var(--live) 9%, transparent)',
              borderLeft: '1px solid color-mix(in oklab, var(--live) 30%, transparent)',
              borderRight: '1px solid color-mix(in oklab, var(--live) 30%, transparent)',
              pointerEvents: 'none',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: 4,
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: 'var(--live)',
                whiteSpace: 'nowrap',
                maxWidth: 'calc(100% - 8px)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {band.name}
            </span>
          </div>
        );
      })}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={buckets} margin={{ top: 8, right: 20, bottom: 5, left: 5 }}>
          <CartesianGrid stroke="var(--border-faint)" strokeDasharray="3 3" />
          <XAxis
            dataKey="ts"
            tickFormatter={(v: string) => {
              const d = new Date(v);
              // Long windows need dates, not clock times — a 30d axis of
              // "14:00" ticks is unreadable.
              return spanHours >= 48
                ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }}
            stroke="var(--fg-dim)"
            fontSize={11}
            minTickGap={40}
          />
          <YAxis
            stroke="var(--fg-dim)"
            fontSize={11}
            width={50}
            tickFormatter={(v: number) => fmtCompact(v)}
          />
          <Tooltip
            contentStyle={{
              background: 'color-mix(in oklab, var(--bg-card) 95%, transparent)',
              border: '1px solid var(--border-strong)',
              borderRadius: 6,
              fontSize: 11.5,
              padding: '8px 10px',
            }}
            labelFormatter={(v: string) => new Date(v).toLocaleString()}
            formatter={(value: number, name: string) => [fmtN(value), name]}
          />
          <Line
            type="monotone"
            dataKey="total_ccv"
            name="Total viewers"
            stroke="var(--red)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      {/* Anchor (single click) */}
      {selectedAnchorIdx !== null && selectedRange === null && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: plotX(idxToPercent(selectedAnchorIdx)),
            width: 1,
            background: 'var(--red)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Selected range overlay */}
      {selectedRange && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            bottom: 26,
            left: plotX(idxToPercent(selectedRange[0])),
            width: plotW((idxToPercent(selectedRange[1]) - idxToPercent(selectedRange[0]))),
            background: 'color-mix(in oklab, var(--red) 12%, transparent)',
            borderLeft: '1px solid var(--red)',
            borderRight: '1px solid var(--red)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Live drag preview */}
      {dragRange && dragRange[0] !== dragRange[1] && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            bottom: 26,
            left: plotX(idxToPercent(dragRange[0])),
            width: plotW((idxToPercent(dragRange[1]) - idxToPercent(dragRange[0]))),
            background: 'color-mix(in oklab, var(--red) 18%, transparent)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Hover indicator */}
      {hoverIdx !== null && !drag && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            bottom: 26,
            left: plotX(idxToPercent(hoverIdx)),
            width: 1,
            background: 'var(--fg-dim)',
            opacity: 0.4,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
