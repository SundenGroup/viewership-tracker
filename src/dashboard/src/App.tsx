import { useState, useCallback, useMemo } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate, useLocation } from 'react-router-dom';
import { Header, Sidebar, MainLayout } from '@/components/layout';
import { EditorDesktop } from '@/pages/EditorDesktop';
import { EditorMobile } from '@/pages/EditorMobile';
import { useViewportBelow } from '@/hooks/useViewport';
import { SurfaceThemeProvider } from '@/design/SurfaceTheme';
import { PublicPage } from '@/pages/PublicPage';
import { ReportPage } from '@/pages/ReportPage';
import { SeriesSetupPage } from '@/pages/SeriesSetupPage';
import { SeriesEditPage } from '@/pages/SeriesEditPage';
import { SeriesFormPage } from '@/pages/SeriesForm';
import { StartPage } from '@/pages/StartPage';
import { LoginPage } from '@/pages/LoginPage';
import { UserManagementPage } from '@/pages/UserManagementPage';
import { YouTubeKeysPage } from '@/pages/YouTubeKeysPage';
import { NotificationsSettingsPage } from '@/pages/NotificationsSettingsPage';
import { ExplorePage } from '@/pages/ExplorePage';
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
        <Route path="/users" element={<AppContent />} />
        <Route path="/settings/youtube-keys" element={<AppContent />} />
        <Route path="/settings/notifications" element={<AppContent />} />
        <Route path="/explore/:seriesId" element={<AppContent />} />
        <Route path="/explore" element={<AppContent />} />
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

  // Derive selected series and current view from URL
  const selectedSeriesId = urlSeriesId;
  const pathname = location.pathname;
  const isEditPage = pathname.endsWith('/edit');
  const isNewPage = pathname === '/new';
  const isUsersPage = pathname === '/users';
  const isYouTubeKeysPage = pathname === '/settings/youtube-keys';
  const isNotificationsPage = pathname === '/settings/notifications';
  const isExplorePage = pathname.startsWith('/explore');

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

  // Desktop v7 Series Form is a self-contained surface with its own chrome.
  // On mobile, fall back to the legacy SeriesSetupPage / SeriesEditPage which
  // already have mobile-friendly single-column flows inside MainLayout.
  if (!isMobile && isNewPage) {
    return (
      <SeriesFormPage
        mode="new"
        onSaved={(newId) => {
          if (newId) handleSeriesCreated(newId);
          else handleSeriesSaved();
        }}
        onCancel={() => navigate(selectedSeriesId ? `/${selectedSeriesId}` : '/')}
      />
    );
  }

  if (!isMobile && isEditPage && selectedSeriesId && seriesDetail) {
    return (
      <SeriesFormPage
        mode="edit"
        seriesId={selectedSeriesId}
        seriesDetail={seriesDetail}
        onSaved={handleSeriesSaved}
        onCancel={() => navigate(`/${selectedSeriesId}`)}
        onDeleted={handleSeriesDeleted}
      />
    );
  }

  // ExplorePage — post-event analysis surface (editor+ only). Self-contained
  // chrome; no MainLayout shell. URL: /explore or /explore/:seriesId.
  if (isExplorePage) {
    return (
      <ExplorePage
        seriesList={seriesList ?? []}
        seriesId={selectedSeriesId ?? null}
        seriesDetail={seriesDetail}
        onSeriesChange={handleSeriesChange}
      />
    );
  }

  // StartPage (no series selected) is self-contained — it brings its own
  // top bar and doesn't need the legacy Sidebar's "select a series…"
  // placeholder columns. We render it on both mobile and desktop so that
  // the EditorMobile hamburger ("back to series list") lands on the new
  // chrome instead of falling through to the legacy MainLayout shell.
  if (!isUsersPage && !isYouTubeKeysPage && !isNotificationsPage && !isNewPage && !isEditPage && !selectedSeriesId) {
    return (
      <StartPage
        seriesList={seriesList ?? []}
        pollingStatus={pollingStatus}
        onSeriesChange={handleSeriesChange}
        onCreate={() => navigate('/new')}
        onOpenUsers={() => navigate('/users')}
        onOpenYouTubeKeys={() => navigate('/settings/youtube-keys')}
        onOpenNotifications={() => navigate('/settings/notifications')}
      />
    );
  }

  // Settings pages now render with the redesigned SettingsShell (top bar
  // matching StartPage / EditorDesktop) instead of the legacy MainLayout +
  // Sidebar chrome. Each page brings its own SettingsShell wrapper.
  if (isUsersPage) {
    return <UserManagementPage />;
  }
  if (isYouTubeKeysPage) {
    return <YouTubeKeysPage />;
  }
  if (isNotificationsPage) {
    return <NotificationsSettingsPage />;
  }

  // Editor Desktop / Mobile are self-contained surfaces with their own shell.
  // The legacy Header/Sidebar/MainLayout is only kept for the edit/setup/users routes.
  if (!isUsersPage && !isYouTubeKeysPage && !isNotificationsPage && !isNewPage && !isEditPage && selectedSeriesId) {
    if (isMobile) {
      return (
        <EditorMobile
          seriesId={selectedSeriesId}
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
      );
    }
    return (
      <EditorDesktop
        seriesId={selectedSeriesId}
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
  }

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
      ) : isYouTubeKeysPage ? (
        <YouTubeKeysPage />
      ) : isNotificationsPage ? (
        <NotificationsSettingsPage />
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
        // Fallback: no series selected → show the start page with greeting,
        // operational stats, filterable series grid, and create CTA.
        <StartPage
          seriesList={seriesList ?? []}
          pollingStatus={pollingStatus}
          onSeriesChange={handleSeriesChange}
          onCreate={() => navigate('/new')}
        />
      )}
    </MainLayout>
  );
}

