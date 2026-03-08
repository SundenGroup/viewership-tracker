import { useState, useCallback } from 'react';
import type {
  LiveCCVResponse,
  MetricsResponse,
  WsSnapshotUpdate,
  WsStatusUpdate,
  PollCycleResult,
} from '@/types/api';
import { useWebSocket } from './useWebSocket';
import { usePollingApi } from './useApi';
import * as api from '@/services/api';
import type { PollingDataState } from './usePollingData';

/**
 * Public version of usePollingData — calls public API endpoints (no auth).
 * Still uses WebSocket for real-time updates (anonymous connections allowed).
 */
export function usePublicPollingData(
  shortName: string | undefined,
  seriesId: string | undefined,
): PollingDataState {
  const [lastPollResult, setLastPollResult] = useState<PollCycleResult | null>(null);
  const [lastStatusChange, setLastStatusChange] = useState<WsStatusUpdate['data'] | null>(null);

  // REST: Live CCV via public endpoint — auto-refresh every 30s
  const {
    data: liveCCV,
    loading: liveCCVLoading,
    error: liveCCVError,
    refetch: refetchLiveCCV,
  } = usePollingApi(
    () =>
      shortName
        ? api.getPublicLiveCCV(shortName)
        : Promise.resolve(null as unknown as LiveCCVResponse),
    [shortName],
    { intervalMs: 30_000, enabled: !!shortName },
  );

  // REST: Metrics via public endpoint — auto-refresh every 30s
  const {
    data: metrics,
    loading: metricsLoading,
    error: metricsError,
    refetch: refetchMetrics,
  } = usePollingApi(
    () =>
      shortName
        ? api.getPublicMetrics(shortName)
        : Promise.resolve(null as unknown as MetricsResponse),
    [shortName],
    { intervalMs: 30_000, enabled: !!shortName },
  );

  // WS handlers
  const handleSnapshotUpdate = useCallback(
    (_data: WsSnapshotUpdate['data']) => {
      setLastPollResult(_data.pollResult);
      refetchLiveCCV();
    },
    [refetchLiveCCV],
  );

  const handleStatusUpdate = useCallback(
    (data: WsStatusUpdate['data']) => {
      setLastStatusChange(data);
    },
    [],
  );

  // WebSocket — subscribes by seriesId (resolved from the public API)
  const { status: wsStatus, reconnect: reconnectWs } = useWebSocket({
    seriesId,
    onSnapshotUpdate: handleSnapshotUpdate,
    onStatusUpdate: handleStatusUpdate,
    // No discovery handler — public clients don't receive discovery updates
  });

  return {
    liveCCV,
    metrics,
    lastPollResult,
    lastDiscoveryResult: null, // Not available for public viewers
    lastStatusChange,
    wsStatus,
    reconnectWs,
    liveCCVLoading,
    metricsLoading,
    liveCCVError,
    metricsError,
    refetchLiveCCV,
    refetchMetrics,
  };
}
