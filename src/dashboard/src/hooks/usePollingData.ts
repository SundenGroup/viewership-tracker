import { useState, useCallback } from 'react';
import type {
  LiveCCVResponse,
  MetricsResponse,
  WsSnapshotUpdate,
  WsDiscoveryUpdate,
  WsStatusUpdate,
  PollCycleResult,
  DiscoveryResult,
} from '@/types/api';
import { useWebSocket } from './useWebSocket';
import { useApi, usePollingApi } from './useApi';
import * as api from '@/services/api';

// ── Combined dashboard data hook ─────────────────────────────────────────

export interface PollingDataState {
  // Live CCV (from REST, updated via WS)
  liveCCV: LiveCCVResponse | null;
  metrics: MetricsResponse | null;

  // From WS
  lastPollResult: PollCycleResult | null;
  lastDiscoveryResult: DiscoveryResult | null;
  lastStatusChange: WsStatusUpdate['data'] | null;

  // WS connection
  wsStatus: string;
  reconnectWs: () => void;

  // REST loading
  liveCCVLoading: boolean;
  metricsLoading: boolean;
  liveCCVError: string | null;
  metricsError: string | null;
  refetchLiveCCV: () => void;
  refetchMetrics: () => void;
}

export function usePollingData(seriesId: string | undefined): PollingDataState {
  const [lastPollResult, setLastPollResult] = useState<PollCycleResult | null>(null);
  const [lastDiscoveryResult, setLastDiscoveryResult] = useState<DiscoveryResult | null>(null);
  const [lastStatusChange, setLastStatusChange] = useState<WsStatusUpdate['data'] | null>(null);

  // REST: Live CCV — auto-refresh every 30s as fallback when WS is flaky
  const {
    data: liveCCV,
    loading: liveCCVLoading,
    error: liveCCVError,
    refetch: refetchLiveCCV,
  } = usePollingApi(
    () => (seriesId ? api.getLiveCCV(seriesId) : Promise.resolve(null as unknown as LiveCCVResponse)),
    [seriesId],
    { intervalMs: 30_000, enabled: !!seriesId },
  );

  // REST: Metrics — auto-refresh every 30s as fallback
  const {
    data: metrics,
    loading: metricsLoading,
    error: metricsError,
    refetch: refetchMetrics,
  } = usePollingApi(
    () => (seriesId ? api.getMetrics('series', seriesId) : Promise.resolve(null as unknown as MetricsResponse)),
    [seriesId],
    { intervalMs: 30_000, enabled: !!seriesId },
  );

  // Handlers for WS messages
  const handleSnapshotUpdate = useCallback(
    (data: WsSnapshotUpdate['data']) => {
      setLastPollResult(data.pollResult);
      // Auto-refetch live CCV to get fresh data
      refetchLiveCCV();
    },
    [refetchLiveCCV],
  );

  const handleDiscoveryUpdate = useCallback(
    (data: WsDiscoveryUpdate['data']) => {
      setLastDiscoveryResult(data.discoveryResult);
    },
    [],
  );

  const handleStatusUpdate = useCallback(
    (data: WsStatusUpdate['data']) => {
      setLastStatusChange(data);
    },
    [],
  );

  // WebSocket connection
  const { status: wsStatus, reconnect: reconnectWs } = useWebSocket({
    seriesId,
    onSnapshotUpdate: handleSnapshotUpdate,
    onDiscoveryUpdate: handleDiscoveryUpdate,
    onStatusUpdate: handleStatusUpdate,
  });

  return {
    liveCCV,
    metrics,
    lastPollResult,
    lastDiscoveryResult,
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
