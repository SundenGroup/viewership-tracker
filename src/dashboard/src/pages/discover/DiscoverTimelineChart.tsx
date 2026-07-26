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

interface Props {
  buckets: Bucket[];
  height?: number;
  selection: Selection | null;
  onPick: (sel: Selection) => void;
  /** Range fetch in flight — dims the chart and blocks the empty state. */
  loading?: boolean;
}

const DRAG_THRESHOLD_PX = 6;
// Plot-area bounds for pointer→bucket mapping and the selection overlays.
// Must match the chart config below: margin.left 5 + YAxis width 50.
const PLOT_LEFT = 55;
const PLOT_RIGHT = 20;

/**
 * Lightweight drag-to-select timeseries for Discover trends. Click a
 * point → emits {fromIso, toIso: null}. Drag → emits {fromIso, toIso}.
 *
 * Mirrors the InteractiveMainChart UX in spirit but keeps the surface
 * small: one series, one set of overlays, no scope/series complexity.
 */
export function DiscoverTimelineChart({ buckets, height = 280, selection, onPick, loading }: Props) {
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
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={buckets} margin={{ top: 8, right: 20, bottom: 5, left: 5 }}>
          <CartesianGrid stroke="var(--border-faint)" strokeDasharray="3 3" />
          <XAxis
            dataKey="ts"
            tickFormatter={(v: string) => {
              const d = new Date(v);
              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
            left: `calc(${PLOT_LEFT}px + ${idxToPercent(selectedAnchorIdx)}% * (100% - ${PLOT_LEFT + PLOT_RIGHT}px) / 100%)`,
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
            left: `calc(${PLOT_LEFT}px + ${idxToPercent(selectedRange[0])}% * (100% - ${PLOT_LEFT + PLOT_RIGHT}px) / 100%)`,
            width: `calc(${(idxToPercent(selectedRange[1]) - idxToPercent(selectedRange[0]))}% * (100% - ${PLOT_LEFT + PLOT_RIGHT}px) / 100%)`,
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
            left: `calc(${PLOT_LEFT}px + ${idxToPercent(dragRange[0])}% * (100% - ${PLOT_LEFT + PLOT_RIGHT}px) / 100%)`,
            width: `calc(${(idxToPercent(dragRange[1]) - idxToPercent(dragRange[0]))}% * (100% - ${PLOT_LEFT + PLOT_RIGHT}px) / 100%)`,
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
            left: `calc(${PLOT_LEFT}px + ${idxToPercent(hoverIdx)}% * (100% - ${PLOT_LEFT + PLOT_RIGHT}px) / 100%)`,
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
