import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/common';
import type { LiveCCVResponse } from '@/types/api';
import { formatNumber } from '@/utils/formatters';

interface TotalCCVPanelProps {
  data: LiveCCVResponse | null;
  loading: boolean;
}

// ── Animated counter hook ────────────────────────────────────────────────

function useAnimatedCounter(target: number, duration = 800): number {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    const from = prevRef.current;
    const diff = target - from;
    if (diff === 0) return;

    const startTime = performance.now();

    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutExpo curve
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = Math.round(from + diff * eased);
      setDisplay(current);

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        prevRef.current = target;
      }
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, duration]);

  return display;
}

// ── Component ────────────────────────────────────────────────────────────

export function TotalCCVPanel({ data, loading }: TotalCCVPanelProps) {
  const totalCCV = data?.totalCCV ?? 0;
  const animatedCCV = useAnimatedCounter(totalCCV);

  const channelCount = data?.channelCount ?? 0;

  // Count unique platforms
  const platforms = new Set(
    (data?.channels ?? []).map((ch) => ch.platform).filter(Boolean),
  );
  const platformCount = platforms.size;

  // Determine change indicator (pulse when non-zero)
  const isLive = totalCCV > 0;

  return (
    <Card className="relative overflow-hidden">
      {/* Background glow effect */}
      {isLive && (
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-20 left-1/2 h-40 w-80 -translate-x-1/2 rounded-full bg-accent-cyan/10 blur-3xl" />
        </div>
      )}

      <div className="relative flex flex-col items-center py-4">
        {/* Live pulse indicator */}
        {isLive && (
          <div className="mb-2 flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-cyan opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent-cyan" />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-accent-cyan">
              Live
            </span>
          </div>
        )}

        {/* Main CCV number */}
        <div
          className={`font-mono text-7xl font-bold tracking-tight transition-colors duration-300 lg:text-8xl ${
            loading && !data
              ? 'text-gray-700'
              : isLive
                ? 'text-accent-cyan'
                : 'text-gray-500'
          }`}
        >
          {loading && !data ? '—' : formatNumber(animatedCCV)}
        </div>

        {/* Label */}
        <div className="mt-2 text-base font-medium text-gray-400">
          Concurrent Viewers
        </div>

        {/* Subtitle */}
        <div className="mt-2 text-sm text-gray-500">
          {loading && !data
            ? 'Loading...'
            : channelCount === 0
              ? 'No active channels'
              : `across ${channelCount} channel${channelCount !== 1 ? 's' : ''} on ${platformCount} platform${platformCount !== 1 ? 's' : ''}`}
        </div>
      </div>
    </Card>
  );
}
