import type {
  TournamentSeries,
  CreateTournamentSeries,
  SeriesWithStages,
  Stage,
  CreateStage,
  BroadcastDay,
  CreateBroadcastDay,
  Channel,
  CreateChannel,
  BulkChannelResult,
  LiveCCVResponse,
  LeaderboardResponse,
  PaginatedSnapshots,
  MetricsResponse,
  TimeSeriesResponse,
  TimeSeriesGroupBy,
  ScopeLevel,
  OrchestratorStatus,
  PollCycleResult,
  DiscoveryStatus,
  DiscoveryResult,
  ReportPayload,
  TournamentStatus,
  BroadcastStatus,
} from '@/types/api';

// ── Base ─────────────────────────────────────────────────────────────────

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...init,
  });

  if (res.status === 204) return undefined as unknown as T;

  // Session expired — reload to show login page
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.location.reload();
    throw new ApiError(401, 'Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText, body);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Health ────────────────────────────────────────────────────────────────

export function getHealth() {
  return request<{ status: string; timestamp: string }>('/health');
}

// ── Tournament Series ─────────────────────────────────────────────────────

export function listSeries(status?: TournamentStatus) {
  const qs = status ? `?status=${status}` : '';
  return request<TournamentSeries[]>(`/api/series${qs}`);
}

export function getSeries(id: string) {
  return request<SeriesWithStages>(`/api/series/${id}`);
}

export function createSeries(data: CreateTournamentSeries) {
  return request<TournamentSeries>('/api/series', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateSeries(id: string, data: Partial<CreateTournamentSeries>) {
  return request<TournamentSeries>(`/api/series/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteSeries(id: string) {
  return request<void>(`/api/series/${id}`, { method: 'DELETE' });
}

export function updateSeriesStatus(id: string, status: TournamentStatus) {
  return request<TournamentSeries>(`/api/series/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

// ── Game ID Lookup ────────────────────────────────────────────────────────

export interface GameLookupResult {
  twitch: { id: string; name: string } | null;
  kick: { id: string; name: string } | null;
}

export function lookupGameIds(gameName: string) {
  return request<GameLookupResult>(`/api/series/games/lookup?name=${encodeURIComponent(gameName)}`);
}

// ── Stages ────────────────────────────────────────────────────────────────

export function listStages(seriesId: string) {
  return request<Stage[]>(`/api/series/${seriesId}/stages`);
}

export function createStage(seriesId: string, data: CreateStage) {
  return request<Stage>(`/api/series/${seriesId}/stages`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateStage(id: string, data: Partial<CreateStage>) {
  return request<Stage>(`/api/stages/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteStage(id: string) {
  return request<void>(`/api/stages/${id}`, { method: 'DELETE' });
}

// ── Broadcast Days ────────────────────────────────────────────────────────

export function listBroadcastDays(stageId: string) {
  return request<BroadcastDay[]>(`/api/stages/${stageId}/days`);
}

export function createBroadcastDay(stageId: string, data: CreateBroadcastDay) {
  return request<BroadcastDay>(`/api/stages/${stageId}/days`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateBroadcastDay(id: string, data: Partial<CreateBroadcastDay>) {
  return request<BroadcastDay>(`/api/days/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteBroadcastDay(id: string) {
  return request<void>(`/api/days/${id}`, { method: 'DELETE' });
}

export function updateBroadcastDayStatus(id: string, status: BroadcastStatus) {
  return request<BroadcastDay>(`/api/days/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

// ── Channels ──────────────────────────────────────────────────────────────

export interface ChannelFilters {
  platform?: string;
  tier?: string;
  is_active?: string;
  source?: string;
}

export function listChannels(seriesId: string, filters?: ChannelFilters) {
  const params = new URLSearchParams();
  if (filters) {
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined) params.set(k, v);
    });
  }
  const qs = params.toString() ? `?${params}` : '';
  return request<Channel[]>(`/api/series/${seriesId}/channels${qs}`);
}

export function createChannel(seriesId: string, data: CreateChannel) {
  return request<Channel>(`/api/series/${seriesId}/channels`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function bulkCreateChannels(seriesId: string, channels: CreateChannel[], broadcastDayIds?: string[]) {
  return request<BulkChannelResult>(`/api/series/${seriesId}/channels/bulk`, {
    method: 'POST',
    body: JSON.stringify({
      channels,
      broadcast_day_ids: broadcastDayIds?.length ? broadcastDayIds : undefined,
    }),
  });
}

export function updateChannel(id: string, data: Partial<CreateChannel>) {
  return request<Channel>(`/api/channels/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteChannel(id: string) {
  return request<void>(`/api/channels/${id}`, { method: 'DELETE' });
}

export function toggleChannelActive(id: string, isActive: boolean) {
  return request<Channel>(`/api/channels/${id}/active`, {
    method: 'PUT',
    body: JSON.stringify({ is_active: isActive }),
  });
}

export function updateChannelDays(channelId: string, broadcastDayIds: string[]) {
  return request<{ broadcast_day_ids: string[] }>(`/api/channels/${channelId}/days`, {
    method: 'PUT',
    body: JSON.stringify({ broadcast_day_ids: broadcastDayIds }),
  });
}

// ── Viewership ────────────────────────────────────────────────────────────

export function getLiveCCV(seriesId: string) {
  return request<LiveCCVResponse>(`/api/viewership/live/${seriesId}`);
}

export function getChannelLeaderboard(seriesId: string, scope?: string, scopeEntityId?: string) {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (scope === 'day' && scopeEntityId) params.set('dayId', scopeEntityId);
  if (scope === 'stage' && scopeEntityId) params.set('stageId', scopeEntityId);
  const qs = params.toString();
  return request<LeaderboardResponse>(`/api/viewership/leaderboard/${seriesId}${qs ? `?${qs}` : ''}`);
}

export interface SnapshotQuery {
  scope: ScopeLevel;
  id: string;
  page?: number;
  limit?: number;
  startTime?: string;
  endTime?: string;
  platform?: string;
  language?: string;
  region?: string;
}

export function getSnapshots(query: SnapshotQuery) {
  const params = new URLSearchParams({ scope: query.scope, id: query.id });
  if (query.page) params.set('page', String(query.page));
  if (query.limit) params.set('limit', String(query.limit));
  if (query.startTime) params.set('startTime', query.startTime);
  if (query.endTime) params.set('endTime', query.endTime);
  if (query.platform) params.set('platform', query.platform);
  if (query.language) params.set('language', query.language);
  if (query.region) params.set('region', query.region);
  return request<PaginatedSnapshots>(`/api/viewership/snapshots?${params}`);
}

export function getMetrics(scope: ScopeLevel, id: string) {
  return request<MetricsResponse>(`/api/viewership/metrics?scope=${scope}&id=${id}`);
}

export interface TimeSeriesQuery {
  scope: ScopeLevel;
  id: string;
  interval?: 60 | 300 | 600;
  groupBy?: TimeSeriesGroupBy;
}

export function getTimeSeries(query: TimeSeriesQuery) {
  const params = new URLSearchParams({ scope: query.scope, id: query.id });
  if (query.interval) params.set('interval', String(query.interval));
  if (query.groupBy) params.set('groupBy', query.groupBy);
  return request<TimeSeriesResponse>(`/api/viewership/timeseries?${params}`);
}

// ── Polling / Orchestrator ─────────────────────────────────────────────────

export function getPollingStatus() {
  return request<OrchestratorStatus>('/api/polling/status');
}

export function triggerPollCycle() {
  return request<PollCycleResult>('/api/polling/trigger', { method: 'POST' });
}

export function startPolling() {
  return request<OrchestratorStatus>('/api/polling/start', { method: 'POST' });
}

export function stopPolling() {
  return request<OrchestratorStatus>('/api/polling/stop', { method: 'POST' });
}

// ── Discovery ──────────────────────────────────────────────────────────────

export function getDiscoveryStatus() {
  return request<DiscoveryStatus>('/api/polling/discovery/status');
}

export function triggerDiscovery(seriesId: string) {
  return request<DiscoveryResult>(`/api/polling/discovery/trigger/${seriesId}`, {
    method: 'POST',
  });
}

export function startDiscovery(seriesId: string) {
  return request<{ started: boolean; seriesId: string }>(
    `/api/polling/discovery/start/${seriesId}`,
    { method: 'POST' },
  );
}

export function stopDiscovery(seriesId: string) {
  return request<{ stopped: boolean; seriesId: string }>(
    `/api/polling/discovery/stop/${seriesId}`,
    { method: 'POST' },
  );
}

export function blockChannel(seriesId: string, channelId: string) {
  return request<{ blocked: boolean; seriesId: string; channelId: string }>(
    '/api/polling/discovery/block',
    { method: 'POST', body: JSON.stringify({ seriesId, channelId }) },
  );
}

export function promoteChannel(channelId: string, tier: string) {
  return request<{ promoted: boolean; channelId: string; tier: string }>(
    '/api/polling/discovery/promote',
    { method: 'POST', body: JSON.stringify({ channelId, tier }) },
  );
}

// ── Export ──────────────────────────────────────────────────────────────────

export function getExportCsvUrl(scope: ScopeLevel, id: string) {
  return `${BASE_URL}/api/export/csv?scope=${scope}&id=${id}`;
}

export function getExportJsonUrl(scope: ScopeLevel, id: string) {
  return `${BASE_URL}/api/export/json?scope=${scope}&id=${id}`;
}

// ── Report Generation ─────────────────────────────────────────────────────

export interface GenerateReportParams {
  scope: ScopeLevel;
  id: string;
  format: 'pdf' | 'docx' | 'html';
  template?: string;
  skipNarratives?: boolean;
  detail?: 'simple' | 'detailed';
}

export interface GenerateReportResult {
  status: string;
  filePath: string;
  scope: string;
  format: string;
  seriesName: string;
  generatedAt: string;
  duration: number;
}

export function generateReport(params: GenerateReportParams) {
  return request<GenerateReportResult>('/api/reports/generate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function getReportUrl(filePath: string) {
  // filePath from the API is like "reports/series_name/day_2026-02-24.html"
  // The API serves it at /api/reports/:folder/:filename
  const parts = filePath.split('/');
  const folder = parts[parts.length - 2];
  const filename = parts[parts.length - 1];
  return `${BASE_URL}/api/reports/${folder}/${filename}`;
}

// ── Report Payload ─────────────────────────────────────────────────────────

export interface ReportPayloadQuery {
  scope: 'day' | 'stage' | 'multi_stage' | 'series' | 'custom';
  id?: string;
  ids?: string[];
  startDate?: string;
  endDate?: string;
}

export function getReportPayload(query: ReportPayloadQuery) {
  const params = new URLSearchParams({ scope: query.scope });
  if (query.id) params.set('id', query.id);
  if (query.ids) params.set('ids', query.ids.join(','));
  if (query.startDate) params.set('startDate', query.startDate);
  if (query.endDate) params.set('endDate', query.endDate);
  return request<ReportPayload>(`/api/report-payload?${params}`);
}

// ── Auth ──────────────────────────────────────────────────────────────────

import type { AuthUser } from '@/types/api';

export function login(data: { email: string; password: string }) {
  return request<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function logout() {
  return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function getMe() {
  return request<{ user: AuthUser }>('/api/auth/me');
}

// ── Admin: User Management ────────────────────────────────────────────────

export function listUsers() {
  return request<AuthUser[]>('/api/auth/users');
}

export function createUser(data: {
  email: string;
  password: string;
  display_name: string;
  role?: string;
}) {
  return request<AuthUser>('/api/auth/users', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateUser(
  id: string,
  data: Partial<{
    email: string;
    display_name: string;
    role: string;
    is_active: boolean;
    password: string;
  }>,
) {
  return request<AuthUser>(`/api/auth/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteUser(id: string) {
  return request<void>(`/api/auth/users/${id}`, { method: 'DELETE' });
}
