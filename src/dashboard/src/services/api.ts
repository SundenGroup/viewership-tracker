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
  SnapshotAtTimestampResponse,
  RangeLeaderboardResponse,
  PushSubscriptionPayload,
  PushSubscriptionPublic,
  PushPreferences,
  VapidPublicKeyResponse,
  PushSendResult,
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
  twitch: Array<{ id: string; name: string }>;
  kick: Array<{ id: string; name: string }>;
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

export function promoteToManual(channelId: string) {
  return request<Channel>(`/api/channels/${channelId}/promote`, {
    method: 'PATCH',
  });
}

// ── Viewership ────────────────────────────────────────────────────────────

/** Append comma-separated filter arrays to URL params when present. */
function appendFilterParams(
  params: URLSearchParams,
  languages?: string[],
  platforms?: string[],
  excludeChannelIds?: string[],
) {
  if (languages?.length) params.set('languages', languages.join(','));
  if (platforms?.length) params.set('platforms', platforms.join(','));
  if (excludeChannelIds?.length) params.set('exclude', excludeChannelIds.join(','));
}

export interface LiveNowEntry {
  series: { id: string; name: string; short_name: string | null; is_public: boolean; game: string | null; partner: string | null };
  day: { id: string; label: string; date: string; broadcast_start: string | null; broadcast_end: string | null; stage_id: string };
}

/** Series with a broadcast day currently live — for the StartPage hero. */
export function getLiveNow() {
  return request<LiveNowEntry[]>(`/api/series/live-now`);
}

export function getLiveCCV(seriesId: string, scope?: string, scopeId?: string, languages?: string[], platforms?: string[]) {
  const params = new URLSearchParams();
  if (scope && scopeId) {
    params.set('scope', scope);
    params.set('id', scopeId);
  }
  appendFilterParams(params, languages, platforms);
  const qs = params.toString();
  return request<LiveCCVResponse>(`/api/viewership/live/${seriesId}${qs ? `?${qs}` : ''}`);
}

export function getChannelLeaderboard(seriesId: string, scope?: string, scopeEntityId?: string, languages?: string[], platforms?: string[]) {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (scope === 'day' && scopeEntityId) params.set('dayId', scopeEntityId);
  if (scope === 'stage' && scopeEntityId) params.set('stageId', scopeEntityId);
  appendFilterParams(params, languages, platforms);
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

export function getMetrics(scope: ScopeLevel, id: string, languages?: string[], platforms?: string[]) {
  const params = new URLSearchParams({ scope, id });
  appendFilterParams(params, languages, platforms);
  return request<MetricsResponse>(`/api/viewership/metrics?${params}`);
}

export interface TimeSeriesQuery {
  scope: ScopeLevel;
  id: string;
  interval?: 60 | 300 | 600;
  groupBy?: TimeSeriesGroupBy;
}

export function getTimeSeries(query: TimeSeriesQuery & { languages?: string[]; platforms?: string[] }) {
  const params = new URLSearchParams({ scope: query.scope, id: query.id });
  if (query.interval) params.set('interval', String(query.interval));
  if (query.groupBy) params.set('groupBy', query.groupBy);
  appendFilterParams(params, query.languages, query.platforms);
  return request<TimeSeriesResponse>(`/api/viewership/timeseries?${params}`);
}

// ── Explore page — snapshot-at-timestamp ──────────────────────────────────
// Returns every channel's CCV at (or near) a specific moment within a series.
export function getSnapshotAtTimestamp(
  seriesId: string,
  timestamp: string,
  withinSeconds = 60,
) {
  const params = new URLSearchParams({
    seriesId,
    timestamp,
    within: String(withinSeconds),
  });
  return request<SnapshotAtTimestampResponse>(
    `/api/viewership/snapshot-at-timestamp?${params}`,
  );
}

// ── Explore page — range-leaderboard ──────────────────────────────────────
// Returns leaderboard stats (peak/avg/viewed-hours per channel) for an
// arbitrary timestamp range within a series. Drives the drag-to-select panel.
export function getRangeLeaderboard(seriesId: string, from: string, to: string) {
  const params = new URLSearchParams({ seriesId, from, to });
  return request<RangeLeaderboardResponse>(
    `/api/viewership/range-leaderboard?${params}`,
  );
}

// ── Explore page — Ask (natural-language) ──────────────────────────────────
// One question about the current Explore view. The server compiles it into a
// single validated intent and answers with either a URL-state patch (the
// page re-render IS the answer), a query result, or a refusal.

/** Current URL params the Explore page sends as its view state. */
export interface AskViewState {
  stage?: string;
  day?: string;
  channels?: string;
  languages?: string;
  platforms?: string;
  tiers?: string;
  regions?: string;
}

export interface AskPatch {
  set: Record<string, string>;
  del: string[];
}

export type AskBlock =
  | { type: 'stat'; label: string; value: number; sub?: string }
  | { type: 'table'; columns: string[]; rows: Array<Array<string | number>> };

export type AskEnvelope =
  | { kind: 'patch'; patch: AskPatch; headline: string; resolvedIntent: string[] }
  | {
      kind: 'answer';
      headline: string;
      blocks: AskBlock[];
      resolvedIntent: string[];
      /** Opt-in follow-up actions the answer card offers ("Filter to RU"). */
      suggestions?: Array<{ label: string; patch: AskPatch }>;
      /** Patch the client auto-applies so the answer is visible on the chart. */
      chartPatch?: AskPatch;
    }
  | { kind: 'refusal'; message: string; suggestions: string[]; resolvedIntent: string[] };

export function askExplore(seriesId: string, question: string, viewState: AskViewState) {
  return request<AskEnvelope>(`/api/ask/explore/${seriesId}`, {
    method: 'POST',
    body: JSON.stringify({ question, viewState }),
  });
}

// ── Discover pages — Ask (natural-language) ────────────────────────────────
// One question about a game tracker. Same server-side contract as Explore
// Ask, but read-only: envelopes are answer|refusal only (no URL patches);
// an answer may carry a deep link into the dashboard and a data-honesty
// footnote (e.g. "chat metrics collected from 2026-07-09").

/** Current URL params the Discover page sends as its view state. */
export interface DiscoverAskViewState {
  tab?: string;
  platform?: string;
  language?: string;
}

export interface DiscoverDeepLink {
  label: string;
  href: string;
}

export type DiscoverAskEnvelope =
  | {
      kind: 'answer';
      headline: string;
      blocks: AskBlock[];
      resolvedIntent: string[];
      /** Optional jump into the dashboard ("Open in Channels tab"). */
      deepLink?: DiscoverDeepLink;
      /** Data-honesty note rendered in the card footer. */
      footnote?: string;
    }
  | { kind: 'refusal'; message: string; suggestions: string[]; resolvedIntent: string[] };

export function askDiscover(slug: string, question: string, viewState: DiscoverAskViewState) {
  return request<DiscoverAskEnvelope>(`/api/ask/discover/${encodeURIComponent(slug)}`, {
    method: 'POST',
    body: JSON.stringify({ question, viewState }),
  });
}

// ── Polling / Orchestrator ─────────────────────────────────────────────────

export function getPollingStatus() {
  return request<OrchestratorStatus>('/api/polling/status');
}

export interface YouTubeQuota {
  used: number;
  limit: number;
  remaining: number;
  percentage: number;
}

export function getYouTubeQuota() {
  return request<YouTubeQuota>('/api/polling/youtube-quota');
}

// ── YouTube API key pool (admin) ────────────────────────────────────────

import type {
  YouTubeApiKey,
  CreateYouTubeApiKey,
  UpdateYouTubeApiKey,
  YouTubeQuotaResponse,
} from '@/types/api';

export function listYouTubeKeys(includeInactive = false) {
  const qs = includeInactive ? '?includeInactive=1' : '';
  return request<{ keys: YouTubeApiKey[] }>(`/api/youtube-keys${qs}`);
}

export function createYouTubeKey(data: CreateYouTubeApiKey) {
  return request<YouTubeApiKey>('/api/youtube-keys', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateYouTubeKey(id: string, data: UpdateYouTubeApiKey) {
  return request<YouTubeApiKey>(`/api/youtube-keys/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteYouTubeKey(id: string) {
  return request<void>(`/api/youtube-keys/${id}`, { method: 'DELETE' });
}

export function getYouTubeQuotaDetailed() {
  return request<YouTubeQuotaResponse>('/api/polling/youtube-quota');
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

export function clearDiscoveryFeed(seriesId: string) {
  return request<{ cleared: boolean; seriesId: string; count: number }>(
    '/api/polling/discovery/clear',
    { method: 'POST', body: JSON.stringify({ seriesId }) },
  );
}

// ── Import (official CSV replace) ───────────────────────────────────────────

export interface CsvImportResult {
  dryRun: boolean;
  channel: { id: string; identifier: string; displayName: string; platform: string };
  day: { id: string; label: string };
  parsed: number;
  skipped: number;
  warnings: string[];
  timezone: string;
  timeMode?: 'clock' | 'offsetSeconds';
  anchor?: { utc: string; source: string } | null;
  range: { fromUtc: string; toUtc: string; fromLocal: string; toLocal: string };
  existingRowsInRange: number;
  sample: {
    first: Array<{ t: string; v: number }>;
    last: Array<{ t: string; v: number }>;
  };
  /** Present on commit (dryRun=false) responses. */
  deleted?: number;
  inserted?: number;
}

export function importViewershipCsv(payload: {
  channelId: string;
  broadcastDayId: string;
  csvText: string;
  date?: string;
  timezone?: string;
  startTime?: string;
  endTime?: string;
  streamStart?: string;
  videoUrl?: string;
  dryRun: boolean;
}) {
  return request<CsvImportResult>('/api/import/csv', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface DiscoverBackfillResult {
  dryRun: boolean;
  channel: { id: string; identifier: string; displayName: string; platform: string };
  day: { id: string; label: string };
  mode: 'replace' | 'fill-gaps';
  source: string;
  timezone: string;
  range: { fromUtc: string; toUtc: string; fromLocal: string; toLocal: string };
  trackerPoints: number;
  existingRowsInRange: number;
  gapMinutes: number;
  willDelete: number;
  willInsert: number;
  sample: {
    first: Array<{ t: string; v: number }>;
    last: Array<{ t: string; v: number }>;
  };
  deleted?: number;
  inserted?: number;
}

export interface RelayHealth {
  twitch: {
    lastPushAt: string | null;
    lastMatched: number;
    lastWritten: number;
    lastSuspected: number;
    totalPushes: number;
    secondsSincePush: number | null;
  };
  tiktok: {
    lastPushAt: string | null;
    lastMatched: number;
    lastWritten: number;
    lastSuspected: number;
    totalPushes: number;
    secondsSincePush: number | null;
  };
  cohostSuspects: string[];
}

export function getRelayHealth() {
  return request<RelayHealth>('/api/relay-health');
}

export interface RosterLivenessRow {
  channelId: string;
  seriesId: string;
  platform: string;
  identifier: string;
  displayName: string;
  live: boolean;
  viewers: number;
  title: string;
  pinnedDayIds: string[];
  pinnedToday: boolean;
}

export interface RosterLivenessResult {
  liveDays: Array<{ id: string; series_id: string; label: string }>;
  probed: number;
  liveNotPinnedToday: RosterLivenessRow[];
  pinnedTodayOffline: RosterLivenessRow[];
}

/** Probe day-pinned channels against the platforms; flags live-but-unpinned-today. */
export function checkRosterLiveness(seriesId: string) {
  return request<RosterLivenessResult>('/api/polling/roster-liveness', {
    method: 'POST',
    body: JSON.stringify({ seriesId }),
  });
}

export interface DayQAResult {
  day: {
    id: string;
    label: string;
    status: string;
    broadcastStart: string;
    broadcastEnd: string;
  };
  totalRows: number;
  minutesWithData: number;
  gaps: Array<{ from: string; to: string; minutes: number }>;
  zeroDataChannels: Array<{
    id: string;
    platform: string;
    channel_identifier: string;
    display_name: string;
    tier: string;
  }>;
  outsideScheduleRows: number;
  cohostSuspectPairs: Array<{ a: string; b: string; shared_minutes: string }>;
  blankLanguageChannels: Array<{
    id: string;
    platform: string;
    channel_identifier: string;
    display_name: string;
  }>;
}

/** Post-event data QA checklist for one broadcast day. */
export function getDayQA(dayId: string) {
  return request<DayQAResult>(`/api/viewership/day-qa/${dayId}`);
}

/** Replace or gap-fill a Twitch/Kick channel's day from the Discover game-tracker. */
export function backfillFromDiscover(payload: {
  channelId: string;
  broadcastDayId: string;
  date?: string;
  timezone?: string;
  startTime?: string;
  endTime?: string;
  mode: 'replace' | 'fill-gaps';
  dryRun: boolean;
}) {
  return request<DiscoverBackfillResult>('/api/import/discover-backfill', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * Export granularity. `per_minute` (default) is the deduped, correct-by-
 * construction grain everyone can export; the others are admin-only
 * (raw = sub-minute polls, easy to double-count; the summaries are
 * pre-aggregated).
 */
export type ExportGranularity = 'per_minute' | 'minute_totals' | 'channel_summary' | 'raw';

function granSuffix(g?: ExportGranularity): string {
  return g && g !== 'per_minute' ? `&granularity=${g}` : '';
}

export function getExportCsvUrl(scope: ScopeLevel, id: string, gran?: ExportGranularity) {
  return `${BASE_URL}/api/export/csv?scope=${scope}&id=${id}${granSuffix(gran)}`;
}

export function getExportJsonUrl(scope: ScopeLevel, id: string, gran?: ExportGranularity) {
  return `${BASE_URL}/api/export/json?scope=${scope}&id=${id}${granSuffix(gran)}`;
}

export function getExportCsvUrlMulti(stageIds: string[], gran?: ExportGranularity) {
  return `${BASE_URL}/api/export/csv?scope=multi_stage&ids=${stageIds.join(',')}${granSuffix(gran)}`;
}

export function getExportJsonUrlMulti(stageIds: string[], gran?: ExportGranularity) {
  return `${BASE_URL}/api/export/json?scope=multi_stage&ids=${stageIds.join(',')}${granSuffix(gran)}`;
}

// ── Report Generation ─────────────────────────────────────────────────────

export interface GenerateReportParams {
  scope: ScopeLevel | 'multi_stage';
  /** Required when scope is day | stage | series. */
  id?: string;
  /** Required when scope is multi_stage. Array of stage UUIDs. */
  ids?: string[];
  format: 'pdf' | 'docx' | 'html';
  template?: string;
  skipNarratives?: boolean;
  detail?: 'simple' | 'detailed';
  viewGroup?: { name: string; languages?: string[]; platforms?: string[] };
  excludeTiers?: string[];
  excludeLanguages?: string[];
  excludeChannelIds?: string[];
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

export function getPublicReportUrl(shortName: string, filename: string) {
  // Public reports are served at /api/public/:shortName/reports/:filename (no auth)
  return `${BASE_URL}/api/public/${shortName}/reports/${filename}`;
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

// ── Public (unauthenticated) API ──────────────────────────────────────────

/** Fetch helper for public endpoints — no auth cookie, no 401 reload. */
async function publicRequest<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText, body);
  }

  return res.json() as Promise<T>;
}

export interface ViewGroup {
  name: string;
  languages?: string[];
  platforms?: string[];
}

export interface PublicSeriesInfo {
  id: string;
  name: string;
  shortName: string;
  game: string | null;
  partner: string | null;
  status: TournamentStatus;
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  viewGroups: ViewGroup[];
  stages: Array<{
    id: string;
    name: string;
    order: number;
    start_date: string | null;
    end_date: string | null;
    broadcast_days: Array<{
      id: string;
      label: string;
      date: string;
      status: BroadcastStatus;
      broadcast_start: string | null;
      broadcast_end: string | null;
    }>;
  }>;
}

export function getPublicSeries(shortName: string) {
  return publicRequest<PublicSeriesInfo>(`/api/public/${shortName}`);
}

/**
 * Sets the right scope+id query param on `params`, given a scope level and
 * either a single id (string) or a list of ids (string[] for multi_stage).
 * Pulled out here so all four scope-aware public helpers stay consistent.
 */
function appendScopeParams(
  params: URLSearchParams,
  scope: string | undefined,
  scopeId: string | string[] | undefined,
): void {
  if (!scope) return;
  params.set('scope', scope);
  if (Array.isArray(scopeId)) {
    if (scope === 'multi_stage' && scopeId.length > 0) {
      params.set('ids', scopeId.join(','));
    }
  } else if (scopeId) {
    params.set('id', scopeId);
  }
}

export function getPublicLiveCCV(
  shortName: string,
  scope?: string,
  scopeId?: string | string[],
  languages?: string[],
  platforms?: string[],
  excludeChannelIds?: string[],
) {
  const params = new URLSearchParams();
  appendScopeParams(params, scope, scopeId);
  appendFilterParams(params, languages, platforms, excludeChannelIds);
  const qs = params.toString();
  return publicRequest<LiveCCVResponse>(`/api/public/${shortName}/live-ccv${qs ? `?${qs}` : ''}`);
}

export function getPublicMetrics(
  shortName: string,
  scope?: ScopeLevel | 'multi_stage',
  id?: string | string[],
  languages?: string[],
  platforms?: string[],
  excludeChannelIds?: string[],
) {
  const params = new URLSearchParams();
  appendScopeParams(params, scope, id);
  appendFilterParams(params, languages, platforms, excludeChannelIds);
  const qs = params.toString() ? `?${params}` : '';
  return publicRequest<MetricsResponse>(`/api/public/${shortName}/metrics${qs}`);
}

export interface PublicLanguagePeak {
  language: string | null;
  peakCCV: number;
  peakAt: string;
  avgCCV: number;
  viewedHours: number;
}

/** Per-language peak moments (+ per-day peaks for growth) for a scope. */
export function getPublicLanguagePeaks(
  shortName: string,
  scope?: ScopeLevel | 'multi_stage',
  id?: string | string[],
  languages?: string[],
  platforms?: string[],
  excludeChannelIds?: string[],
) {
  const params = new URLSearchParams();
  appendScopeParams(params, scope, id);
  appendFilterParams(params, languages, platforms, excludeChannelIds);
  const qs = params.toString() ? `?${params}` : '';
  return publicRequest<{ languages: PublicLanguagePeak[] }>(
    `/api/public/${shortName}/language-peaks${qs}`,
  );
}

export function getPublicTimeSeries(
  shortName: string,
  query: Omit<TimeSeriesQuery, 'scope' | 'id'> & {
    scope?: ScopeLevel | 'multi_stage';
    id?: string;
    /** Required when scope === 'multi_stage'. Array of stage UUIDs. */
    ids?: string[];
    languages?: string[];
    platforms?: string[];
    excludeChannelIds?: string[];
  },
) {
  const params = new URLSearchParams();
  if (query.scope === 'multi_stage' && query.ids?.length) {
    appendScopeParams(params, query.scope, query.ids);
  } else {
    appendScopeParams(params, query.scope, query.id);
  }
  if (query.interval) params.set('interval', String(query.interval));
  if (query.groupBy) params.set('groupBy', query.groupBy);
  appendFilterParams(params, query.languages, query.platforms, query.excludeChannelIds);
  return publicRequest<TimeSeriesResponse>(`/api/public/${shortName}/timeseries?${params}`);
}

export function getPublicLeaderboard(
  shortName: string,
  scope?: string,
  scopeEntityId?: string | string[],
  languages?: string[],
  platforms?: string[],
) {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (Array.isArray(scopeEntityId)) {
    if (scope === 'multi_stage' && scopeEntityId.length > 0) {
      params.set('ids', scopeEntityId.join(','));
    }
  } else {
    if (scope === 'day' && scopeEntityId) params.set('dayId', scopeEntityId);
    if (scope === 'stage' && scopeEntityId) params.set('stageId', scopeEntityId);
  }
  appendFilterParams(params, languages, platforms);
  const qs = params.toString();
  return publicRequest<LeaderboardResponse>(`/api/public/${shortName}/leaderboard${qs ? `?${qs}` : ''}`);
}

// ── Web Push notifications ────────────────────────────────────────────────

export function getVapidPublicKey() {
  return request<VapidPublicKeyResponse>('/api/push/vapid-public-key');
}

export function subscribeToPush(
  subscription: PushSubscriptionPayload,
  preferences?: Partial<PushPreferences>,
) {
  return request<PushSubscriptionPublic>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      subscription,
      preferences,
      userAgent: navigator.userAgent,
    }),
  });
}

export function unsubscribeFromPush(endpoint: string) {
  return request<{ ok: boolean }>('/api/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  });
}

export function listPushSubscriptions() {
  return request<{ subscriptions: PushSubscriptionPublic[] }>('/api/push/subscriptions');
}

export function updatePushPreferences(endpoint: string, preferences: Partial<PushPreferences>) {
  return request<PushSubscriptionPublic>('/api/push/preferences', {
    method: 'PUT',
    body: JSON.stringify({ endpoint, preferences }),
  });
}

export function sendTestPush() {
  return request<PushSendResult>('/api/push/test', { method: 'POST' });
}

// ── Live Game Tracker (Discover) ──────────────────────────────────────────

export interface GameTracker {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'paused';
  twitch_game_id: string | null;
  twitch_game_name: string | null;
  kick_category_id: number | null;
  kick_category_slug: string | null;
  min_ccv_threshold: number;
  mismatch_threshold_cycles: number;
  discovery_interval_seconds: number;
  polling_interval_seconds: number;
  max_active_channels: number;
  youtube_enabled?: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface GameTrackerDetail extends GameTracker {
  active_channel_count: number;
  youtube_config?: YouTubeTrackerConfig;
  last_cycle: {
    snapshotsWritten: number;
    newChannels: number;
    bumpedMismatch: number;
    dropped: number;
    durationMs: number;
  } | null;
}

/** Per-tracker YouTube discovery + gating rules (Discover). */
export interface YouTubeTrackerConfig {
  /** Search phrases used to find live streams. */
  queries?: string[];
  /** Title must contain one of these to reach the review queue. */
  include?: string[];
  /** Title containing any of these is auto-denied. */
  exclude?: string[];
  strongTags?: string[];
  strongPhrases?: string[];
  autoAllowWeakBelowCcv?: number;
  alwaysReviewAboveCcv?: number;
  discoveryPagesPerQuery?: number;
  discoveryIntervalSeconds?: number;
  maxRoster?: number;
}

export type YouTubeGatingDecision = 'allow' | 'deny' | 'pending';

/**
 * How much of an approved channel counts.
 *   matching — variety streamer: only their streams about this game
 *   all      — dedicated channel (org/tournament): everything they stream
 */
export type YouTubeGatingScope = 'matching' | 'all';

export interface YouTubeGatingRow {
  id: string;
  channel_identifier: string;
  display_name: string | null;
  decision: YouTubeGatingDecision;
  scope: YouTubeGatingScope;
  reason: string | null;
  sample_title: string | null;
  sample_video_id: string | null;
  sample_ccv: number | null;
  last_seen_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export interface YouTubeGatingResponse {
  enabled: boolean;
  config: YouTubeTrackerConfig;
  counts: Record<YouTubeGatingDecision, number>;
  rows: YouTubeGatingRow[];
}

/** Review queue + decisions for a tracker's YouTube channels (admin). */
export function getYouTubeGating(slug: string, decision?: YouTubeGatingDecision) {
  const qs = decision ? `?decision=${decision}` : '';
  return request<YouTubeGatingResponse>(
    `/api/game-trackers/${encodeURIComponent(slug)}/youtube/gating${qs}`,
  );
}

export function decideYouTubeGating(
  slug: string,
  channelIdentifier: string,
  decision: 'allow' | 'deny' | 'reset',
  note?: string,
  scope: YouTubeGatingScope = 'matching',
) {
  return request<YouTubeGatingRow | { ok: true }>(
    `/api/game-trackers/${encodeURIComponent(slug)}/youtube/gating/${encodeURIComponent(channelIdentifier)}`,
    { method: 'POST', body: JSON.stringify({ decision, note, scope }) },
  );
}

/** Save a tracker's YouTube matching vocabulary + dials (admin). */
export function saveYouTubeConfig(
  slug: string,
  config: YouTubeTrackerConfig,
  enabled?: boolean,
) {
  return request<{ enabled: boolean; config: YouTubeTrackerConfig }>(
    `/api/game-trackers/${encodeURIComponent(slug)}/youtube/config`,
    { method: 'PUT', body: JSON.stringify({ config, enabled }) },
  );
}

export interface CreateGameTracker {
  name: string;
  slug: string;
  status?: 'active' | 'paused';
  twitch_game_id?: string | null;
  twitch_game_name?: string | null;
  kick_category_id?: number | null;
  kick_category_slug?: string | null;
  min_ccv_threshold?: number;
  mismatch_threshold_cycles?: number;
  discovery_interval_seconds?: number;
  polling_interval_seconds?: number;
  youtube_enabled?: boolean;
  youtube_config?: YouTubeTrackerConfig;
}

export interface GameTrackerLeaderboardRow {
  channel_id: string;
  concurrent_viewers: number;
  stream_title: string | null;
  platform: string;
  language: string | null;
  timestamp: string;
  channel: {
    id: string;
    display_name: string;
    channel_identifier: string;
    platform: string;
    metadata: Record<string, unknown>;
  } | null;
}

export interface GameTrackerRangeBucket {
  ts: string;
  total_ccv: number;
  stream_count: number;
}

export interface GameTrackerPlatformBreakdown {
  platform: string;
  total_ccv_minutes: number;
  peak: number;
}

export interface GameTrackerLanguageBreakdown {
  language: string | null;
  total_ccv_minutes: number;
  peak: number;
}

export interface GameTrackerChannelTimelineBucket {
  ts: string;
  concurrent_viewers: number;
  stream_title: string | null;
  stream_id: string | null;
}

export interface GameTrackerChannelSession {
  stream_id: string | null;
  stream_title: string | null;
  peak_ccv: number;
  avg_ccv: number;
  minutes_live: number;
  started_at: string;
  ended_at: string;
}

export interface GameTrackerChannelTimelineResponse {
  from: string;
  to: string;
  bucket_seconds: number;
  channel: {
    id: string;
    display_name: string;
    channel_identifier: string;
    platform: string;
    metadata: Record<string, unknown>;
  };
  timeline: GameTrackerChannelTimelineBucket[];
  sessions: GameTrackerChannelSession[];
}

export interface GameTrackerSearchRow {
  channel_id: string;
  last_seen: string;
  stream_title: string | null;
  peak_ccv: number;
  matched_field: 'title' | 'channel';
  channel: {
    id: string;
    display_name: string;
    channel_identifier: string;
    platform: string;
    metadata: Record<string, unknown>;
  } | null;
}

export interface GameTrackerRangeLeaderboardRow {
  channel_id: string;
  peak_ccv: number;
  avg_ccv: number;
  minutes_live: number;
  days_streamed: number;
  platform: string;
  language: string | null;
  channel: {
    id: string;
    display_name: string;
    channel_identifier: string;
    platform: string;
    metadata: Record<string, unknown>;
  } | null;
}

export function listGameTrackers() {
  return request<GameTracker[]>('/api/game-trackers');
}

export function getGameTracker(slug: string) {
  return request<GameTrackerDetail>(`/api/game-trackers/${slug}`);
}

export function createGameTracker(data: CreateGameTracker) {
  return request<GameTracker>('/api/game-trackers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateGameTracker(slug: string, data: Partial<CreateGameTracker>) {
  return request<GameTracker>(`/api/game-trackers/${slug}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteGameTracker(slug: string) {
  return request<void>(`/api/game-trackers/${slug}`, { method: 'DELETE' });
}

export function getGameTrackerLeaderboard(slug: string, at?: Date, limit = 50) {
  const params = new URLSearchParams();
  if (at) params.set('at', at.toISOString());
  params.set('limit', String(limit));
  return request<GameTrackerLeaderboardRow[]>(
    `/api/game-trackers/${slug}/leaderboard?${params.toString()}`,
  );
}

export function getGameTrackerRange(
  slug: string,
  from: Date,
  to: Date,
  bucketSeconds = 60,
) {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSeconds: String(bucketSeconds),
  });
  return request<{
    from: string;
    to: string;
    bucket_seconds: number;
    buckets: GameTrackerRangeBucket[];
  }>(`/api/game-trackers/${slug}/snapshots/range?${params.toString()}`);
}

export function getGameTrackerBreakdown(slug: string, from: Date, to: Date) {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  return request<{
    from: string;
    to: string;
    platform: GameTrackerPlatformBreakdown[];
    language: GameTrackerLanguageBreakdown[];
  }>(`/api/game-trackers/${slug}/breakdown?${params.toString()}`);
}

export function getGameTrackerChannelTimeline(
  slug: string,
  channelId: string,
  from: Date,
  to: Date,
  bucketSeconds = 60,
) {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSeconds: String(bucketSeconds),
  });
  return request<GameTrackerChannelTimelineResponse>(
    `/api/game-trackers/${slug}/channels/${channelId}/timeline?${params.toString()}`,
  );
}

export interface GameTrackerTrendingRow {
  channel_id: string;
  cur_peak: number;
  prev_peak: number;
  is_new: boolean;
  channel: {
    id: string;
    display_name: string;
    channel_identifier: string;
    platform: string;
    metadata: Record<string, unknown>;
  } | null;
}

/** Risers & anomalies: peak in the last N hours vs the N hours before. */
export function getGameTrackerTrending(slug: string, hours = 24, limit = 20) {
  const params = new URLSearchParams({ hours: String(hours), limit: String(limit) });
  return request<{ hours: number; rows: GameTrackerTrendingRow[] }>(
    `/api/game-trackers/${slug}/trending?${params.toString()}`,
  );
}

export interface GameTrackerRecentChannelRow {
  joined_at: string;
  channel_id: string;
  platform: string;
  channel_identifier: string;
  display_name: string;
  language: string | null;
  peak: number;
}

/** Channels the tracker discovered within the window, newest first. */
export function getGameTrackerRecentChannels(slug: string, hours = 48, limit = 15) {
  const params = new URLSearchParams({ hours: String(hours), limit: String(limit) });
  return request<{ hours: number; rows: GameTrackerRecentChannelRow[] }>(
    `/api/game-trackers/${slug}/recent-channels?${params.toString()}`,
  );
}

export function searchGameTracker(slug: string, query: string, days = 30, limit = 50) {
  const params = new URLSearchParams({
    q: query,
    days: String(days),
    limit: String(limit),
  });
  return request<{
    query: string;
    days: number;
    rows: GameTrackerSearchRow[];
  }>(`/api/game-trackers/${slug}/search?${params.toString()}`);
}

export function getGameTrackerRangeLeaderboard(
  slug: string,
  from: Date,
  to: Date,
  limit = 50,
  opts: { language?: string; platform?: string; offset?: number } = {},
) {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    limit: String(limit),
  });
  if (opts.language) params.set('language', opts.language);
  if (opts.platform) params.set('platform', opts.platform);
  if (opts.offset) params.set('offset', String(opts.offset));
  return request<{
    from: string;
    to: string;
    total?: number;
    rows: GameTrackerRangeLeaderboardRow[];
  }>(`/api/game-trackers/${slug}/range-leaderboard?${params.toString()}`);
}

// ── Game Tracker — streamer depth (sessions / stream detail / summary) ────
// Frozen contract shared with the backend work happening in parallel.
// Chat and follower data may legitimately be absent (empty arrays / nulls);
// consumers must degrade gracefully rather than assume presence.

export interface GameTrackerTitleChange {
  title: string;
  at: string;
}

// Stream health (integrity signals) — nullable on every session; only
// ended sessions with enough size + chat coverage ever get a grade.
export interface GameTrackerHealthFlag {
  kind: string;
  detail: string;
  /** 'critical' = damning on its own (caps the grade at F). */
  severity?: 'critical';
}

export interface GameTrackerHealthEvidence {
  engagementPct: number | null;
  cohort: { tracker: string; band: string; n: number } | null;
  flags: GameTrackerHealthFlag[];
  /** Out of engagement 40 / curve 30 / followers 15 / spikeResponse 15. */
  subscores: {
    engagement: number;
    curve: number;
    followers: number;
    spikeResponse: number;
  } | null;
  /** Pre-gate subscore sum, present only when a flag gate moved the score. */
  rawScore?: number;
}

export interface GameTrackerStreamSessionRow {
  id: string;
  stream_id: string;
  started_at: string;
  ended_at: string | null;
  status: 'live' | 'ended';
  minutes_live: number;
  peak_ccv: number;
  avg_ccv: number;
  ccv_minutes: number;
  titles: GameTrackerTitleChange[];
  category: string | null;
  followers_start: number | null;
  followers_end: number | null;
  messages: number;
  unique_chatters: number;
  health_score: number | null;
  health_grade: string | null;
  health_evidence: GameTrackerHealthEvidence | null;
}

/** Present (non-null) while a channel has fewer scored sessions than the
 *  server's evidence gate — health fields are suppressed until then. */
export interface GameTrackerHealthPending {
  scored: number;
  required: number;
}

export interface GameTrackerChannelSessionsResponse {
  total: number;
  rows: GameTrackerStreamSessionRow[];
  healthPending?: GameTrackerHealthPending | null;
}

export function getGameTrackerChannelSessions(
  slug: string,
  channelId: string,
  limit = 50,
  offset = 0,
) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<GameTrackerChannelSessionsResponse>(
    `/api/game-trackers/${slug}/channels/${channelId}/sessions?${params.toString()}`,
  );
}

export interface GameTrackerStreamTimelinePoint {
  ts: string;
  ccv: number;
}

export interface GameTrackerStreamChatMinute {
  minute: string;
  messages: number;
  chatters: number;
}

export interface GameTrackerStreamDetailResponse {
  healthPending?: GameTrackerHealthPending | null;
  session: GameTrackerStreamSessionRow;
  timeline: GameTrackerStreamTimelinePoint[];
  chat: GameTrackerStreamChatMinute[];
  followers: { start: number | null; end: number | null; delta: number | null } | null;
  titleChanges: GameTrackerTitleChange[];
  rank: { byPeakInTracker: number | null; of: number | null } | null;
  prevStreamId: string | null;
  nextStreamId: string | null;
}

export function getGameTrackerStreamDetail(slug: string, channelId: string, streamId: string) {
  return request<GameTrackerStreamDetailResponse>(
    `/api/game-trackers/${slug}/channels/${channelId}/streams/${streamId}`,
  );
}

export interface GameTrackerChannelSummary {
  followers: { current: number | null; delta7d: number | null } | null;
  rank: { todayByPeak: number | null; of: number | null } | null;
  peakPercentile30d: number | null;
  engagement: { avgChattersPerViewerPct: number | null } | null;
  /** Grade letter from the avg health_score of scored sessions (30d). */
  healthGrade30d: string | null;
  healthAvgScore30d: number | null;
  healthScoredSessions30d: number;
  /** Scored sessions needed before grades are shown (server evidence gate). */
  healthMinSessions?: number;
}

export function getGameTrackerChannelSummary(slug: string, channelId: string) {
  return request<GameTrackerChannelSummary>(
    `/api/game-trackers/${slug}/channels/${channelId}/summary`,
  );
}
