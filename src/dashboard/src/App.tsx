import { useState, useCallback, useMemo } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate, useLocation } from 'react-router-dom';
import { Header, Sidebar, MainLayout } from '@/components/layout';
import { DashboardPage } from '@/pages/DashboardPage';
import { PublicDashboardPage } from '@/pages/PublicDashboardPage';
import { SeriesSetupPage } from '@/pages/SeriesSetupPage';
import { SeriesEditPage } from '@/pages/SeriesEditPage';
import { LoginPage } from '@/pages/LoginPage';
import { UserManagementPage } from '@/pages/UserManagementPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Spinner } from '@/components/common/Loader';
import { useApi, usePollingApi } from '@/hooks/useApi';
import { usePollingData } from '@/hooks/usePollingData';
import { AuthContext, useAuth, useAuthProvider } from '@/hooks/useAuth';
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
  const auth = useAuthProvider();

  return (
    <AuthContext.Provider value={auth}>
      {/* basename mirrors Vite's --base flag so the legacy build deployed at
          /legacy/ navigates correctly while a dev/local build at / keeps
          working. import.meta.env.BASE_URL is "/legacy/" or "/" depending on
          the build flag. */}
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Routes>
          {/* Public routes — no auth required */}
          <Route path="/public/:shortName/*" element={<PublicDashboardPage />} />
          <Route path="/public/:shortName" element={<PublicDashboardPage />} />

          {/* Authenticated routes — behind auth gate */}
          <Route path="/*" element={<AuthGate />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}

// ── Auth Gate — shows login or authenticated app ────────────────────────────

function AuthGate() {
  const auth = useAuth();

  if (auth.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-950">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!auth.user) {
    return <LoginPage />;
  }

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/new" element={<AppContent />} />
        <Route path="/users" element={<AppContent />} />
        <Route path="/:seriesId/edit" element={<AppContent />} />
        <Route path="/:seriesId" element={<AppContent />} />
        <Route path="/" element={<AppContent />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </ErrorBoundary>
  );
}

// ── App Content (only renders when authenticated) ─────────────────────────

function AppContent() {
  const { seriesId: urlSeriesId } = useParams<{ seriesId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  // Derive selected series and current view from URL
  const selectedSeriesId = urlSeriesId;
  const pathname = location.pathname;
  const isEditPage = pathname.endsWith('/edit');
  const isNewPage = pathname === '/new';
  const isUsersPage = pathname === '/users';

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

  // ── Sidebar: Extend broadcast day end time ───────────────────────────

  const handleExtendBroadcast = useCallback(
    async (dayId: string, minutes: number) => {
      if (!seriesDetail) return;
      // Find the broadcast day to get current broadcast_end
      let broadcastEnd: string | null = null;
      for (const stage of seriesDetail.stages) {
        const day = stage.broadcast_days.find((d) => d.id === dayId);
        if (day) {
          broadcastEnd = day.broadcast_end;
          break;
        }
      }
      const base = Math.max(
        broadcastEnd ? new Date(broadcastEnd).getTime() : Date.now(),
        Date.now(),
      );
      const newEnd = new Date(base + minutes * 60_000).toISOString();

      setBdStatusLoading(dayId);
      try {
        await api.updateBroadcastDay(dayId, { broadcast_end: newEnd });
        refetchSeriesDetail();
      } catch { /* ignore */ }
      finally { setBdStatusLoading(undefined); }
    },
    [seriesDetail, refetchSeriesDetail],
  );

  // ── Sidebar: Channel management ───────────────────────────────────────

  const [channelRefreshKey, setChannelRefreshKey] = useState(0);

  const handleChannelAdded = useCallback(() => {
    refetchSeriesDetail();
    setChannelRefreshKey((k) => k + 1);
  }, [refetchSeriesDetail]);

  // ── Navigation helpers ──────────────────────────────────────────────────

  const handleSeriesChange = useCallback(
    (id: string) => {
      navigate(id ? `/${id}` : '/');
    },
    [navigate],
  );

  const handleSeriesCreated = useCallback(
    (newSeriesId: string) => {
      refetchSeriesList();
      navigate(`/${newSeriesId}`);
    },
    [navigate, refetchSeriesList],
  );

  const handleSeriesSaved = useCallback(() => {
    refetchSeriesDetail();
    refetchSeriesList();
    navigate(selectedSeriesId ? `/${selectedSeriesId}` : '/');
  }, [navigate, selectedSeriesId, refetchSeriesDetail, refetchSeriesList]);

  const handleSeriesDeleted = useCallback(() => {
    refetchSeriesList();
    navigate('/');
  }, [navigate, refetchSeriesList]);

  // ── Mobile sidebar state ──────────────────────────────────────────────

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const handleToggleSidebar = useCallback(() => {
    setMobileSidebarOpen((v) => !v);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <MainLayout
      header={
        <Header
          seriesList={seriesList ?? []}
          selectedSeriesId={selectedSeriesId}
          onSeriesChange={handleSeriesChange}
          wsStatus={pollingData.wsStatus as ConnectionStatus}
          onToggleSidebar={handleToggleSidebar}
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
          onExtendBroadcast={handleExtendBroadcast}
          onChannelAdded={handleChannelAdded}
          pollLoading={pollLoading}
          discoveryLoading={discoveryLoading}
          broadcastDayStatusLoading={bdStatusLoading}
          onClose={mobileSidebarOpen ? handleCloseSidebar : undefined}
        />
      }
      sidebarOpen={mobileSidebarOpen}
      onCloseSidebar={handleCloseSidebar}
    >
      {isUsersPage ? (
        <UserManagementPage />
      ) : isNewPage ? (
        <SeriesSetupPage
          onCreated={handleSeriesCreated}
          onCancel={() => navigate(selectedSeriesId ? `/${selectedSeriesId}` : '/')}
        />
      ) : isEditPage && selectedSeriesId && seriesDetail ? (
        <SeriesEditPage
          seriesId={selectedSeriesId}
          seriesDetail={seriesDetail}
          onSaved={handleSeriesSaved}
          onCancel={() => navigate(`/${selectedSeriesId}`)}
          onDeleted={handleSeriesDeleted}
        />
      ) : (
        <DashboardPage
          seriesId={selectedSeriesId}
          seriesDetail={seriesDetail}
          pollingData={pollingData}
          broadcastStart={broadcastStart}
          channelRefreshKey={channelRefreshKey}
        />
      )}
    </MainLayout>
  );
}
