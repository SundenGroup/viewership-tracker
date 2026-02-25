// ── Auth ──────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

// ── Enums / Literals ──────────────────────────────────────────────────────

export type TournamentStatus = 'draft' | 'active' | 'completed';
export type BroadcastStatus = 'scheduled' | 'live' | 'completed';
export type Platform = 'twitch' | 'youtube' | 'kick' | 'tiktok';
export type ChannelTier = 'primary' | 'secondary' | 'community' | 'watch_party';
export type ChannelSource = 'manual' | 'auto_discovered';
export type ScopeLevel = 'day' | 'stage' | 'series';
export type MetricType = 'vod_views' | 'clip_views' | 'total_video_views';

// ── Tournament Series ─────────────────────────────────────────────────────

export interface TournamentSeries {
  id: string;
  name: string;
  short_name: string | null;
  game: string | null;
  partner: string | null;
  status: TournamentStatus;
  min_role: UserRole;
  start_date: string | null;
  end_date: string | null;
  discovery_keywords: string[];
  discovery_game_ids: Record<string, string>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateTournamentSeries {
  name: string;
  short_name?: string;
  game?: string;
  partner?: string;
  status?: TournamentStatus;
  min_role?: UserRole;
  start_date?: string;
  end_date?: string;
  discovery_keywords?: string[];
  discovery_game_ids?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface SeriesWithStages extends TournamentSeries {
  stages: Array<Stage & { broadcast_days: BroadcastDay[] }>;
}

// ── Stage ──────────────────────────────────────────────────────────────────

export interface Stage {
  id: string;
  series_id: string;
  name: string;
  order: number;
  start_date: string | null;
  end_date: string | null;
  status: TournamentStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateStage {
  name: string;
  order: number;
  start_date?: string;
  end_date?: string;
  status?: TournamentStatus;
  metadata?: Record<string, unknown>;
}

// ── Broadcast Day ──────────────────────────────────────────────────────────

export interface BroadcastDay {
  id: string;
  stage_id: string;
  series_id: string;
  label: string;
  date: string;
  broadcast_start: string | null;
  broadcast_end: string | null;
  status: BroadcastStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateBroadcastDay {
  label: string;
  date: string;
  broadcast_start?: string;
  broadcast_end?: string;
  status?: BroadcastStatus;
  metadata?: Record<string, unknown>;
}

// ── Channel ────────────────────────────────────────────────────────────────

export interface Channel {
  id: string;
  series_id: string;
  platform: Platform;
  channel_identifier: string;
  display_name: string;
  language: string | null;
  region: string | null;
  tier: ChannelTier;
  source: ChannelSource;
  is_active: boolean;
  added_at: string;
  metadata: Record<string, unknown>;
}

export interface CreateChannel {
  platform: Platform;
  channel_identifier: string;
  display_name: string;
  language?: string;
  region?: string;
  tier?: ChannelTier;
  source?: ChannelSource;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
}

export interface BulkChannelResult {
  created: Channel[];
  errors: Array<{ index: number; error: string }>;
}

// ── Viewership Snapshot ────────────────────────────────────────────────────

export interface ViewershipSnapshot {
  id: string;
  channel_id: string;
  broadcast_day_id: string | null;
  stage_id: string | null;
  series_id: string | null;
  timestamp: string;
  concurrent_viewers: number;
  platform: string | null;
  language: string | null;
  region: string | null;
}

// ── Live CCV Response ──────────────────────────────────────────────────────

export interface LiveCCVResponse {
  seriesId: string;
  timestamp: string | null;
  totalCCV: number;
  channelCount: number;
  liveChannels: number;
  channels: Array<{
    channelId: string;
    displayName: string;
    channelIdentifier: string;
    platform: string | null;
    concurrentViewers: number;
    language: string | null;
    region: string | null;
    timestamp: string;
  }>;
}

// ── Paginated Snapshots ────────────────────────────────────────────────────

export interface PaginatedSnapshots {
  data: ViewershipSnapshot[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ── Metrics ────────────────────────────────────────────────────────────────

export interface BreakdownEntry {
  /** The key varies by breakdown type: 'platform', 'language', or 'region'. */
  platform?: string;
  language?: string;
  region?: string;
  /** Legacy alias — some endpoints use 'key' instead of a named field. */
  key?: string;
  totalCCV: number;
  avgCCV: number;
  peakCCV: number;
  /** Snake_case aliases for components that still reference the old shape. */
  total_ccv?: string;
  avg_ccv?: string;
  peak_ccv?: string;
}

export interface LeaderboardEntry {
  channelId: string;
  displayName: string;
  platform: string;
  peakCCV: number;
  avgCCV: number;
  totalViewedMinutes: number;
  /** Snake_case aliases for backward compatibility. */
  channel_id?: string;
  display_name?: string;
  peak_ccv?: string;
  avg_ccv?: string;
  total_viewed_minutes?: string;
}

export interface MetricsResponse {
  scope: { level: ScopeLevel; id: string };
  peakCCV: { timestamp: string; totalCCV: number } | null;
  avgCCV: number;
  totalViewedHours: number;
  platformBreakdown: BreakdownEntry[];
  languageBreakdown: BreakdownEntry[];
  regionBreakdown: BreakdownEntry[];
  channelLeaderboard: LeaderboardEntry[];
}

// ── Time Series ────────────────────────────────────────────────────────────

export interface TimeSeriesBucket {
  timestamp: string;
  totalCCV: number;
  channelCount: number;
  /** Legacy raw SQL aliases. */
  bucket?: string;
  total_ccv?: string;
  channel_count?: string;
}

export interface GroupedTimeSeriesBucket {
  timestamp: string;
  groupKey: string;
  totalCCV: number;
  channelCount: number;
  /** Legacy raw SQL aliases. */
  bucket?: string;
  total_ccv?: string;
  channel_count?: string;
}

export type TimeSeriesGroupBy = 'total' | 'platform' | 'language' | 'region' | 'channel';

export interface TimeSeriesResponse {
  scope: { level: ScopeLevel; id: string };
  interval: number;
  groupBy: string;
  data: TimeSeriesBucket[] | GroupedTimeSeriesBucket[];
}

// ── Polling / Orchestrator ─────────────────────────────────────────────────

export interface PollCycleResult {
  timestamp: string;
  channelsPolled: number;
  totalCCV: number;
  snapshotsCreated: number;
  errors: string[];
  duration: number;
}

export interface OrchestratorStatus {
  state: 'running' | 'stopped';
  activeBroadcastDays: number;
  lastPollTime: string | null;
  lastPollResult: PollCycleResult | null;
}

// ── Discovery ──────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  seriesId: string;
  timestamp: string;
  discovered: number;
  added: number;
  alreadyTracked: number;
  belowThreshold: number;
  blocked: number;
  errors: string[];
  duration: number;
}

export interface DiscoveryStatus {
  activeDiscoveries: string[];
  lastResults: Record<string, DiscoveryResult>;
}

// ── Report Payload ─────────────────────────────────────────────────────────

export interface ReportPayload {
  generatedAt: string;
  scope: string;
  series: {
    id: string;
    name: string;
    shortName: string | null;
    game: string | null;
    partner: string | null;
    status: TournamentStatus;
    startDate: string | null;
    endDate: string | null;
  };
  stages: Array<{
    id: string;
    name: string;
    order: number;
    status: TournamentStatus;
    startDate: string | null;
    endDate: string | null;
  }>;
  broadcastDays: Array<{
    id: string;
    stageId: string;
    label: string;
    date: string;
    broadcastStart: string | null;
    broadcastEnd: string | null;
    status: BroadcastStatus;
  }>;
  channels: Array<{
    id: string;
    platform: Platform;
    channelIdentifier: string;
    displayName: string;
    language: string | null;
    region: string | null;
    tier: ChannelTier;
    source: ChannelSource;
  }>;
  snapshotCount: number;
  metrics: Array<{
    broadcastDayId: string;
    peakCCV: number;
    peakTimestamp: string | null;
    avgCCV: number;
    totalViewedHours: number;
    platformBreakdown: BreakdownEntry[];
    languageBreakdown: BreakdownEntry[];
    regionBreakdown: BreakdownEntry[];
    channelLeaderboard: LeaderboardEntry[];
  }>;
}

// ── WebSocket Messages ─────────────────────────────────────────────────────

export interface WsWelcome {
  type: 'welcome';
  data: {
    activeSeries: Array<{ id: string; name: string; status: string }>;
    liveBroadcastDays: BroadcastDay[];
  };
}

export interface WsSnapshotUpdate {
  type: 'snapshot_update';
  data: {
    seriesId: string;
    pollResult: PollCycleResult;
    latestSnapshots: Array<ViewershipSnapshot & { display_name: string }>;
  };
}

export interface WsDiscoveryUpdate {
  type: 'discovery_update';
  data: {
    seriesId: string;
    discoveryResult: DiscoveryResult;
  };
}

export interface WsStatusUpdate {
  type: 'status_update';
  data: {
    seriesId: string;
    broadcastDayId: string;
    previousStatus: string;
    newStatus: string;
  };
}

export interface WsPong {
  type: 'pong';
}

export interface WsError {
  type: 'error';
  data: { message: string };
}

export type WsServerMessage =
  | WsWelcome
  | WsSnapshotUpdate
  | WsDiscoveryUpdate
  | WsStatusUpdate
  | WsPong
  | WsError;
