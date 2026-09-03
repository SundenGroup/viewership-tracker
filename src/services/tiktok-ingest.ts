/**
 * TikTok reading ingest, shared by the relay endpoint (POST /api/relay/tiktok,
 * pushed from residential machines) and the server-side page tracker
 * (tiktok-server-tracker.ts). One code path, one set of rules:
 *
 *   1. values are validated (normalizeRelayViewers) so one bad entry never
 *      fails a batch;
 *   2. the plunge guard holds a sudden collapse one cycle for a second
 *      opinion (tiktok-ingest-guard.ts);
 *   3. a source that repeats the identical value for minutes while another
 *      source moves is stale and ignored (tiktok-merge.ts);
 *   4. per channel and minute, a higher-ranked source is never overwritten
 *      by a lower-ranked one; equal ranks keep the larger value.
 *
 * Rows snap to the most recent bulk poll timestamp so relay data joins the
 * same time bucket as the main poll cycle.
 */
import db from '../utils/db';
import logger from '../utils/logger';
import { normalizeRelayViewers } from '../utils/relay-values';
import { TikTokIngestGuard } from './tiktok-ingest-guard';
import { StaleSourceTracker, normalizeSource, shouldReplace, type TikTokSource } from '../utils/tiktok-merge';

export interface TikTokReading {
  identifier: string;
  viewers: unknown;
  title?: string | null;
  displayName?: string | null;
  source?: string | null;
}

export interface TikTokIngestResult {
  matched: number;
  snapshotsInserted: number;
  snapshotsUpdated: number;
  deferred: number;
  released: number;
  invalid: number;
  stale: number;
  affectedSeriesIds: string[];
}

const guard = new TikTokIngestGuard();
const staleTracker = new StaleSourceTracker();
/** Source that wrote each (channel row, minute); in-memory, best effort. */
const minuteSource = new Map<string, TikTokSource>();
let minuteSourceSweptAt = 0;

function sweepMinuteSource(nowMs: number): void {
  if (nowMs - minuteSourceSweptAt < 10 * 60_000) return;
  minuteSourceSweptAt = nowMs;
  const cutoff = Math.floor(nowMs / 60_000) - 30;
  for (const key of minuteSource.keys()) {
    const minute = Number(key.slice(key.lastIndexOf('|') + 1));
    if (minute < cutoff) minuteSource.delete(key);
  }
}

export async function ingestTikTokReadings(
  readings: TikTokReading[],
  defaultSource: string = 'unknown',
): Promise<TikTokIngestResult> {
  const result: TikTokIngestResult = {
    matched: 0, snapshotsInserted: 0, snapshotsUpdated: 0, deferred: 0, released: 0, invalid: 0, stale: 0, affectedSeriesIds: [],
  };
  if (readings.length === 0) return result;

  const recentBulk = await db('viewership_snapshots')
    .where('timestamp', '>', db.raw("NOW() - INTERVAL '2 minutes'"))
    .groupBy('timestamp')
    .having(db.raw('COUNT(*) > 1'))
    .orderBy('timestamp', 'desc')
    .limit(1)
    .select('timestamp')
    .first();
  const timestamp = recentBulk ? new Date(recentBulk.timestamp) : new Date();

  const dbChannels = await db('channels')
    .where('platform', 'tiktok')
    .where('is_active', true)
    .select('id', 'series_id', 'channel_identifier', 'language', 'region');
  const channelMap = new Map<string, typeof dbChannels>();
  for (const ch of dbChannels) {
    const key = ch.channel_identifier.toLowerCase().replace(/^@/, '');
    const list = channelMap.get(key) ?? [];
    list.push(ch);
    channelMap.set(key, list);
  }

  const seriesIds = [...new Set(dbChannels.map((c) => c.series_id))];
  const activeDays = seriesIds.length > 0
    ? await db('broadcast_days').whereIn('series_id', seriesIds).where('status', 'live').select('id', 'series_id', 'stage_id')
    : [];
  const seriesToDays = new Map<string, typeof activeDays>();
  for (const day of activeDays) {
    const list = seriesToDays.get(day.series_id) ?? [];
    list.push(day);
    seriesToDays.set(day.series_id, list);
  }
  const channelIds = dbChannels.map((c) => c.id);
  const assignments = channelIds.length > 0
    ? await db('channel_broadcast_days').whereIn('channel_id', channelIds).select('channel_id', 'broadcast_day_id')
    : [];
  const channelDayMap = new Map<string, Set<string>>();
  for (const a of assignments) {
    const set = channelDayMap.get(a.channel_id) ?? new Set<string>();
    set.add(a.broadcast_day_id);
    channelDayMap.set(a.channel_id, set);
  }

  type Row = Record<string, unknown> & { channel_id: string; timestamp: Date; concurrent_viewers: number; series_id: string; source: TikTokSource };
  const insertRows: Row[] = [];
  const buildRows = (key: string, viewers: number, title: string | null, ts: Date, source: TikTokSource): boolean => {
    const matches = channelMap.get(key);
    if (!matches) return false;
    for (const ch of matches) {
      const days = seriesToDays.get(ch.series_id) ?? [];
      const assignedDays = channelDayMap.get(ch.id);
      for (const day of days) {
        if (assignedDays && assignedDays.size > 0 && !assignedDays.has(day.id)) continue;
        insertRows.push({
          channel_id: ch.id,
          broadcast_day_id: day.id,
          stage_id: day.stage_id,
          series_id: day.series_id,
          timestamp: ts,
          concurrent_viewers: viewers,
          platform: 'tiktok',
          language: ch.language,
          region: ch.region,
          stream_id: null,
          stream_title: title,
          source,
        });
      }
      result.matched++;
    }
    return true;
  };

  const nowMs = Date.now();
  sweepMinuteSource(nowMs);
  for (const input of readings) {
    const key = (input.identifier || '').toLowerCase().replace(/^@/, '');
    if (!channelMap.has(key)) continue;
    const viewers = normalizeRelayViewers(input.viewers);
    if (viewers === null) { result.invalid++; continue; }
    const source = normalizeSource(input.source ?? defaultSource);

    // Stale-source rule before the guard: a frozen reading must not even
    // count as a "second opinion" for the plunge guard.
    const st = staleTracker.observe(key, source, viewers, timestamp.getTime(), nowMs);
    if (st.stale) {
      result.stale++;
      logger.warn(`[TikTokIngest] ${key}: ${source} repeated ${viewers} for ${st.repeats} minutes while another source moved; ignored as stale`);
      continue;
    }

    const verdict = guard.assess(key, viewers, timestamp);
    if (verdict.action === 'defer') { result.deferred++; continue; }
    if (verdict.release) {
      buildRows(key, verdict.release.viewers, input.title ?? null, verdict.release.timestamp, source);
      result.released++;
    }
    buildRows(key, viewers, input.title ?? null, timestamp, source);
  }

  for (const row of insertRows) {
    const minuteKey = `${row.channel_id}|${Math.floor(row.timestamp.getTime() / 60_000)}`;
    const existing = await db('viewership_snapshots')
      .where('channel_id', row.channel_id)
      .whereRaw("date_trunc('minute', \"timestamp\") = date_trunc('minute', ?::timestamptz)", [row.timestamp.toISOString()])
      .where('platform', 'tiktok')
      .first();
    const { source, ...dbRow } = row;
    if (!existing) {
      await db('viewership_snapshots').insert(dbRow);
      minuteSource.set(minuteKey, source);
      result.snapshotsInserted++;
      continue;
    }
    const existingSource = minuteSource.get(minuteKey) ?? null;
    if (shouldReplace({ value: Number(existing.concurrent_viewers), source: existingSource }, { value: row.concurrent_viewers, source })) {
      await db('viewership_snapshots').where('id', existing.id).update({ concurrent_viewers: row.concurrent_viewers });
      minuteSource.set(minuteKey, source);
      result.snapshotsUpdated++;
    }
  }
  result.affectedSeriesIds = [...new Set(insertRows.map((r) => r.series_id))];
  return result;
}
