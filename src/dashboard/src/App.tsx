import { useState, useCallback, useMemo } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useNavigate, useLocation } from 'react-router-dom';
import { EditorDesktop } from '@/pages/EditorDesktop';
import { EditorMobile } from '@/pages/EditorMobile';
import { useViewportBelow } from '@/hooks/useViewport';
import { SurfaceThemeProvider } from '@/design/SurfaceTheme';
import { PublicPage } from '@/pages/PublicPage';
import { ReportPage } from '@/pages/ReportPage';
import { SeriesFormPage } from '@/pages/SeriesForm';
import { StartPage } from '@/pages/StartPage';
import { LoginPage } from '@/pages/LoginPage';
import { UserManagementPage } from '@/pages/UserManagementPage';
import { YouTubeKeysPage } from '@/pages/YouTubeKeysPage';
import { NotificationsSettingsPage } from '@/pages/NotificationsSettingsPage';
import { ExplorePage } from '@/pages/ExplorePage';
import { DiscoverListPage } from '@/pages/discover/DiscoverListPage';
import { DiscoverDetailPage } from '@/pages/discover/DiscoverDetailPage';
import { DiscoverChannelPage } from '@/pages/discover/DiscoverChannelPage';
import { DiscoverAdminNew } from '@/pages/discover/DiscoverAdminNew';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { TopNav } from '@/components/nav';
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
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <SurfaceThemeProvider>
          <Routes>
            {/* Public routes — no auth required. Wrap in ErrorBoundary so a
                single render crash doesn't leave fans staring at a blank page. */}
            <Route
              path="/public/:shortName/report/simple/:scopeSlug"
              element={
                <ErrorBoundary>
                  <ReportPage variant="simple" />
                </ErrorBoundary>
              }
            />
            <Route
              path="/public/:shortName/report/simple"
              element={
                <ErrorBoundary>
                  <ReportPage variant="simple" />
                </ErrorBoundary>
              }
            />
            <Route
              path="/public/:shortName/report/detailed/:scopeSlug"
              element={
                <ErrorBoundary>
                  <ReportPage variant="detailed" />
                </ErrorBoundary>
              }
            />
            <Route
              path="/public/:shortName/report/detailed"
              element={
                <ErrorBoundary>
                  <ReportPage variant="detailed" />
                </ErrorBoundary>
              }
            />
            <Route
              path="/public/:shortName/*"
              element={
                <ErrorBoundary>
                  <PublicPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/public/:shortName"
              element={
                <ErrorBoundary>
                  <PublicPage />
                </ErrorBoundary>
              }
            />

            {/* Authenticated routes — behind auth gate */}
            <Route path="/*" element={<AuthGate />} />
          </Routes>
        </SurfaceThemeProvider>
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
        {/* /users canonicalised under the Settings hub (P3) */}
        <Route path="/users" element={<Navigate to="/settings/users" replace />} />
        <Route path="/settings" element={<AppContent />} />
        <Route path="/settings/users" element={<AppContent />} />
        <Route path="/settings/youtube-keys" element={<AppContent />} />
        <Route path="/settings/notifications" element={<AppContent />} />
        <Route path="/explore/:seriesId" element={<AppContent />} />
        <Route path="/explore" element={<AppContent />} />
        <Route path="/discover/admin/new" element={<AppContent />} />
        <Route path="/discover/admin/edit/:slug" element={<AppContent />} />
        <Route path="/discover/:slug/channel/:channelId" element={<AppContent />} />
        <Route path="/discover/:slug" element={<AppContent />} />
        <Route path="/discover" element={<AppContent />} />
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
  const isMobile = useViewportBelow(900);
  const { isAdmin } = useAuth();

  // Derive selected series and current view from URL
  const selectedSeriesId = urlSeriesId;
  const pathname = location.pathname;
  const isEditPage = pathname.endsWith('/edit');
  const isNewPage = pathname === '/new';
  const isSettingsHome = pathname === '/settings';
  const isUsersPage = pathname === '/settings/users';
  const isYouTubeKeysPage = pathname === '/settings/youtube-keys';
  const isNotificationsPage = pathname === '/settings/notifications';
  const isExplorePage = pathname.startsWith('/explore');
  const isDiscoverNew = pathname === '/discover/admin/new';
  const isDiscoverEdit = /^\/discover\/admin\/edit\/[^/]+$/.test(pathname);
  const isDiscoverChannel = /^\/discover\/[^/]+\/channel\/[^/]+$/.test(pathname);
  const isDiscoverDetail = /^\/discover\/[^/]+$/.test(pathname) && !isDiscoverNew;
  const isDiscoverList = pathname === '/discover';

  // ── Data fetching ─────────────────────────────────────────────────────

  // Series list (for dropdown)
  const { data: seriesList, refetch: refetchSeriesList } = useApi<TournamentSeries[]>(
    () => api.listSeries(),
    [],
  );

  // Selected series detail (with stages/broadcast days)
  const {
    data: seriesDetail,
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

  // ── Render ─────────────────────────────────────────────────────────────
  // Every authenticated surface renders below the single persistent TopNav.
  // Public routes (/public/*) live outside AuthGate and never mount TopNav.

  const isEditorSurface =
    !!selectedSeriesId &&
    !isEditPage &&
    !isNewPage &&
    !isExplorePage &&
    !isDiscoverList &&
    !isDiscoverDetail &&
    !isDiscoverChannel &&
    !isDiscoverNew &&
    !isDiscoverEdit;

  let content: React.ReactNode;

  if (isNewPage) {
    content = (
      <SeriesFormPage
        mode="new"
        onSaved={(newId) => {
          if (newId) handleSeriesCreated(newId);
          else handleSeriesSaved();
        }}
        onCancel={() => navigate(selectedSeriesId ? `/${selectedSeriesId}` : '/')}
      />
    );
  } else if (isEditPage && selectedSeriesId && seriesDetail) {
    content = (
      <SeriesFormPage
        mode="edit"
        seriesId={selectedSeriesId}
        seriesDetail={seriesDetail}
        onSaved={handleSeriesSaved}
        onCancel={() => navigate(`/${selectedSeriesId}`)}
        onDeleted={handleSeriesDeleted}
      />
    );
  } else if (isEditPage) {
    // Edit route, series detail still loading — show a spinner, not the
    // legacy chrome flash.
    content = (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
        <Spinner size="lg" />
      </div>
    );
  } else if (isDiscoverList) {
    content = <DiscoverListPage />;
  } else if (isDiscoverChannel) {
    content = <DiscoverChannelPage />;
  } else if (isDiscoverDetail) {
    content = <DiscoverDetailPage />;
  } else if (isDiscoverNew || isDiscoverEdit) {
    content = <DiscoverAdminNew />;
  } else if (isExplorePage) {
    content = (
      <ExplorePage
        seriesList={seriesList ?? []}
        seriesId={selectedSeriesId ?? null}
        seriesDetail={seriesDetail}
        onSeriesChange={handleSeriesChange}
      />
    );
  } else if (isSettingsHome) {
    // Settings hub landing arrives in P3; for now route to the first page
    // the user is allowed to see.
    content = <Navigate to={isAdmin ? '/settings/users' : '/settings/notifications'} replace />;
  } else if (isUsersPage) {
    content = <UserManagementPage />;
  } else if (isYouTubeKeysPage) {
    content = <YouTubeKeysPage />;
  } else if (isNotificationsPage) {
    content = <NotificationsSettingsPage />;
  } else if (isEditorSurface) {
    content = isMobile ? (
      <EditorMobile
        seriesId={selectedSeriesId!}
        seriesList={seriesList ?? []}
        seriesDetail={seriesDetail}
        pollingData={pollingData}
        pollingStatus={pollingStatus}
        discoveryStatus={discoveryStatus}
        onSeriesChange={handleSeriesChange}
        onExtendBroadcast={handleExtendBroadcast}
        onBroadcastDayStatusChange={handleBroadcastDayStatusChange}
        onTriggerPoll={handleTriggerPoll}
        onStartPolling={handleStartPolling}
        onStopPolling={handleStopPolling}
        onTriggerDiscovery={handleTriggerDiscovery}
        onStartDiscovery={handleStartDiscovery}
        onStopDiscovery={handleStopDiscovery}
        pollLoading={pollLoading}
        discoveryLoading={discoveryLoading}
      />
    ) : (
      <EditorDesktop
        seriesId={selectedSeriesId!}
        seriesList={seriesList ?? []}
        seriesDetail={seriesDetail}
        pollingData={pollingData}
        pollingStatus={pollingStatus}
        discoveryStatus={discoveryStatus}
        onSeriesChange={handleSeriesChange}
        onExtendBroadcast={handleExtendBroadcast}
        onBroadcastDayStatusChange={handleBroadcastDayStatusChange}
        onTriggerPoll={handleTriggerPoll}
        onStartPolling={handleStartPolling}
        onStopPolling={handleStopPolling}
        pollLoading={pollLoading}
        onChannelAdded={handleChannelAdded}
      />
    );
  } else {
    content = (
      <StartPage
        seriesList={seriesList ?? []}
        pollingStatus={pollingStatus}
        onSeriesChange={handleSeriesChange}
        onCreate={() => navigate('/new')}
      />
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
    >
      <TopNav
        seriesList={seriesList ?? []}
        activeSeriesId={selectedSeriesId ?? null}
        pollingStatus={pollingStatus}
        wsStatus={isEditorSurface ? (pollingData.wsStatus as ConnectionStatus) : undefined}
      />
      <div style={{ flex: 1, minHeight: 0 }}>{content}</div>
    </div>
  );
}

