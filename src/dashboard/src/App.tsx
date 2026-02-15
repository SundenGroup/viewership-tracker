import { useState, useCallback, useMemo } from 'react';
import { Header, Sidebar, MainLayout } from '@/components/layout';
import type { AppView } from '@/components/layout/Header';
import { DashboardPage } from '@/pages/DashboardPage';
import { SeriesSetupPage } from '@/pages/SeriesSetupPage';
import { SeriesEditPage } from '@/pages/SeriesEditPage';
import { useApi, usePollingApi } from '@/hooks/useApi';
import { usePollingData } from '@/hooks/usePollingData';
import type { ConnectionStatus } from '@/hooks/useWebSocket';
import * as api from '@/services/api';
import type {
  TournamentSeries,
  SeriesWithStages,
  OrchestratorStatus,
  DiscoveryStatus,
  BroadcastStatus,
} from '@/types/api';

export default function App() {
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | undefined>();
  const [currentView, setCurrentView] = useState<AppView>('dashboard');

  // ── Data fetching ─────────────────────────────────────────────────────

  // Series list (for dropdown)
  const { data: seriesList, refetch: refetchSeriesList } = useApi<TournamentSeries[]>(
    () => api.listSeries(),
    [],
  );

  // Selected series detail (with stages/broadcast days)
  const {
    data: seriesDetail,
    loading: seriesDetailLoading,
    refetch: refetchSeriesDetail,
  } = useApi<SeriesWithStages | null>(
    () => (selectedSeriesId ? api.getSeries(selectedSeriesId) : Promise.resolve(null)),
    [selectedSeriesId],
  );

  // Polling status (refreshes every 5s)
  const { data: pollingStatus } = usePollingApi<OrchestratorStatus>(
    () => api.getPollingStatus(),
    [],
    { intervalMs: 5_000 },
  );

  // Discovery status (refreshes every 10s)
  const { data: discoveryStatus } = usePollingApi<DiscoveryStatus>(
    () => api.getDiscoveryStatus(),
    [],
    { intervalMs: 10_000 },
  );

  // Live data via WS + REST
  const pollingData = usePollingData(selectedSeriesId);

  // ── Derived: earliest live broadcast start ─────────────────────────────

  const broadcastStart = useMemo(() => {
    if (!seriesDetail) return null;
    for (const stage of seriesDetail.stages) {
      for (const day of stage.broadcast_days) {
        if (day.status === 'live' && day.broadcast_start) {
          return day.broadcast_start;
        }
      }
    }
    return null;
  }, [seriesDetail]);

  // ── Sidebar: Polling / Discovery actions ──────────────────────────────

  const [pollLoading, setPollLoading] = useState(false);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);

  const handleStartPolling = useCallback(async () => {
    try { await api.startPolling(); } catch { /* ignore */ }
  }, []);

  const handleStopPolling = useCallback(async () => {
    try { await api.stopPolling(); } catch { /* ignore */ }
  }, []);

  const handleTriggerPoll = useCallback(async () => {
    setPollLoading(true);
    try { await api.triggerPollCycle(); } catch { /* ignore */ }
    finally { setPollLoading(false); }
  }, []);

  const handleStartDiscovery = useCallback(async () => {
    if (!selectedSeriesId) return;
    try { await api.startDiscovery(selectedSeriesId); } catch { /* ignore */ }
  }, [selectedSeriesId]);

  const handleStopDiscovery = useCallback(async () => {
    if (!selectedSeriesId) return;
    try { await api.stopDiscovery(selectedSeriesId); } catch { /* ignore */ }
  }, [selectedSeriesId]);

  const handleTriggerDiscovery = useCallback(async () => {
    if (!selectedSeriesId) return;
    setDiscoveryLoading(true);
    try { await api.triggerDiscovery(selectedSeriesId); } catch { /* ignore */ }
    finally { setDiscoveryLoading(false); }
  }, [selectedSeriesId]);

  // ── Sidebar: Broadcast day status change ──────────────────────────────

  const [bdStatusLoading, setBdStatusLoading] = useState<string | undefined>();

  const handleBroadcastDayStatusChange = useCallback(
    async (dayId: string, newStatus: BroadcastStatus) => {
      setBdStatusLoading(dayId);
      try {
        await api.updateBroadcastDayStatus(dayId, newStatus);
        refetchSeriesDetail();
      } catch { /* ignore */ }
      finally { setBdStatusLoading(undefined); }
    },
    [refetchSeriesDetail],
  );

  // ── Sidebar: Channel management ───────────────────────────────────────

  const [channelRefreshKey, setChannelRefreshKey] = useState(0);

  const handleChannelAdded = useCallback(() => {
    refetchSeriesDetail();
    setChannelRefreshKey((k) => k + 1);
  }, [refetchSeriesDetail]);

  // ── Navigation ────────────────────────────────────────────────────────

  const handleNavigate = useCallback((view: AppView) => {
    setCurrentView(view);
  }, []);

  const handleSeriesCreated = useCallback(
    (newSeriesId: string) => {
      setSelectedSeriesId(newSeriesId);
      setCurrentView('dashboard');
      refetchSeriesList();
    },
    [refetchSeriesList],
  );

  const handleSeriesSaved = useCallback(() => {
    refetchSeriesDetail();
    refetchSeriesList();
    setCurrentView('dashboard');
  }, [refetchSeriesDetail, refetchSeriesList]);

  const handleSeriesDeleted = useCallback(() => {
    setSelectedSeriesId(undefined);
    setCurrentView('dashboard');
    refetchSeriesList();
  }, [refetchSeriesList]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <MainLayout
      header={
        <Header
          seriesList={seriesList ?? []}
          selectedSeriesId={selectedSeriesId}
          onSeriesChange={setSelectedSeriesId}
          wsStatus={pollingData.wsStatus as ConnectionStatus}
          currentView={currentView}
          onNavigate={handleNavigate}
        />
      }
      sidebar={
        <Sidebar
          seriesId={selectedSeriesId}
          seriesDetail={seriesDetail}
          seriesDetailLoading={seriesDetailLoading}
          pollingStatus={pollingStatus}
          discoveryStatus={discoveryStatus}
          onStartPolling={handleStartPolling}
          onStopPolling={handleStopPolling}
          onTriggerPoll={handleTriggerPoll}
          onStartDiscovery={handleStartDiscovery}
          onStopDiscovery={handleStopDiscovery}
          onTriggerDiscovery={handleTriggerDiscovery}
          onBroadcastDayStatusChange={handleBroadcastDayStatusChange}
          onChannelAdded={handleChannelAdded}
          pollLoading={pollLoading}
          discoveryLoading={discoveryLoading}
          broadcastDayStatusLoading={bdStatusLoading}
        />
      }
    >
      {currentView === 'dashboard' ? (
        <DashboardPage
          seriesId={selectedSeriesId}
          seriesDetail={seriesDetail}
          pollingData={pollingData}
          broadcastStart={broadcastStart}
          channelRefreshKey={channelRefreshKey}
        />
      ) : currentView === 'series-edit' && selectedSeriesId && seriesDetail ? (
        <SeriesEditPage
          seriesId={selectedSeriesId}
          seriesDetail={seriesDetail}
          onSaved={handleSeriesSaved}
          onCancel={() => setCurrentView('dashboard')}
          onDeleted={handleSeriesDeleted}
        />
      ) : (
        <SeriesSetupPage
          onCreated={handleSeriesCreated}
          onCancel={() => setCurrentView('dashboard')}
        />
      )}
    </MainLayout>
  );
}
