/**
 * Retroactive promotion of held YouTube snapshots.
 *
 * When a reviewer approves a channel, everything the quarantine held for
 * it becomes real history: the rows are copied into
 * game_tracker_snapshots with their ORIGINAL poll timestamps, so charts,
 * leaderboards and reports read as if the channel had been tracked from
 * the moment it first appeared — review latency stops costing data.
 *
 * Scope is honoured the same way live gating honours it: 'all' promotes
 * every held row, 'matching' only rows whose title matches the tracker's
 * own vocabulary (the rest would never have been tracked live either).
 * Non-promoted rows are deleted with the promoted ones — a decision
 * consumes the whole hold.
 */
import db from '../utils/db';
import logger from '../utils/logger';
import type { GameTracker } from '../models/game-tracker';
import * as GameTrackerChannelModel from '../models/game-tracker-channel';
import * as Quarantine from '../models/game-tracker-youtube-quarantine';
import { rollupDay, utcDay } from './gt-day-rollup';
import { titleMatchesGame, type YouTubeTrackerConfig } from './youtube-game-tracker';
import type { Channel } from '../models/channel';

export interface PromotionResult {
  /** Snapshot rows copied into the real table. */
  promoted: number;
  /** Held rows discarded (scope mismatch under 'matching'). */
  skipped: number;
  /** Distinct minutes of viewership the promoted rows represent. */
  minutes: number;
}

/**
 * Split held rows into promote/discard per the approval scope. Pure —
 * exported for tests.
 */
export function selectPromotable(
  rows: Quarantine.HeldSnapshot[],
  scope: 'matching' | 'all',
  cfg: YouTubeTrackerConfig,
): { promote: Quarantine.HeldSnapshot[]; skip: Quarantine.HeldSnapshot[] } {
  if (scope === 'all') return { promote: rows, skip: [] };
  const promote: Quarantine.HeldSnapshot[] = [];
  const skip: Quarantine.HeldSnapshot[] = [];
  for (const r of rows) {
    if (titleMatchesGame(r.stream_title, cfg)) promote.push(r);
    else skip.push(r);
  }
  return { promote, skip };
}

/**
 * The stub series a tracker's channels hang off (channels.series_id is
 * NOT NULL). Read path mirrors GameTrackerService.ensureBoundSeries:
 * tracker.metadata first, then the stub row by its deterministic
 * short_name; creating one here is the rare case (a tracker approving
 * its very first channel via the queue).
 */
async function resolveBoundSeriesId(tracker: GameTracker): Promise<string> {
  const stored = (tracker.metadata as Record<string, unknown> | null)?.bound_series_id;
  if (typeof stored === 'string' && stored.length > 0) return stored;

  const stubShortName = `gt-${tracker.slug}`;
  const existing = await db('tournament_series')
    .where('short_name', stubShortName)
    .where(db.raw(`metadata->>'is_game_tracker_stub' = 'true'`))
    .select('id')
    .first();
  let seriesId: string;
  if (existing) {
    seriesId = existing.id as string;
  } else {
    const [created] = await db('tournament_series')
      .insert({
        name: `[game-tracker] ${tracker.name}`,
        short_name: stubShortName,
        status: 'active',
        timezone: 'UTC',
        auto_start_polling: false,
        is_public: false,
        metadata: JSON.stringify({
          is_game_tracker_stub: true,
          game_tracker_id: tracker.id,
        }),
      })
      .returning('id');
    seriesId = created.id as string;
  }
  await db('game_trackers')
    .where('id', tracker.id)
    .update({
      metadata: db.raw('metadata || ?::jsonb', [JSON.stringify({ bound_series_id: seriesId })]),
    });
  return seriesId;
}

const normLang = (lang: string | null): string | null =>
  lang ? lang.split('-')[0].toLowerCase() : null;

/**
 * Promote a channel's held snapshots after an 'allow' decision.
 * Idempotent in effect: the hold is emptied inside the same transaction
 * that copies it, so a retry finds nothing to promote.
 */
export async function promoteHeldSnapshots(
  tracker: GameTracker,
  channelIdentifier: string,
  scope: 'matching' | 'all',
): Promise<PromotionResult> {
  const held = await Quarantine.listForChannel(tracker.id, channelIdentifier);
  if (held.length === 0) return { promoted: 0, skipped: 0, minutes: 0 };

  const cfg = (tracker.youtube_config ?? {}) as YouTubeTrackerConfig;
  const { promote, skip } = selectPromotable(held, scope, cfg);
  if (promote.length === 0) {
    const dropped = await Quarantine.discardChannel(tracker.id, channelIdentifier);
    logger.info(
      `[YTQuarantine] ${tracker.slug}/${channelIdentifier}: nothing matched scope '${scope}', discarded ${dropped} held rows`,
    );
    return { promoted: 0, skipped: skip.length, minutes: 0 };
  }

  // Newest row wins for channel presentation fields.
  const newest = promote[promote.length - 1];

  // Channel + stub series live OUTSIDE the copy transaction: they're
  // idempotent upserts of real entities, harmless if a later step fails.
  let channel = await db<Channel>('channels')
    .where('platform', 'youtube')
    .whereRaw('LOWER(channel_identifier) = ?', [channelIdentifier.toLowerCase()])
    .first();
  if (!channel) {
    const seriesId = await resolveBoundSeriesId(tracker);
    const [created] = (await db('channels')
      .insert({
        series_id: seriesId,
        platform: 'youtube',
        channel_identifier: channelIdentifier,
        display_name: newest.display_name ?? channelIdentifier,
        language: normLang(newest.language),
        tier: 'community',
        source: 'auto_discovered',
        is_active: true,
        metadata: JSON.stringify({
          game_tracker_managed: true,
          game_tracker_id: tracker.id,
          last_seen_at: new Date().toISOString(),
        }),
      })
      .returning('*')) as Channel[];
    channel = created;
  }

  const minuteSet = new Set<number>();
  const daySet = new Set<string>();
  for (const r of promote) {
    const t = new Date(r.timestamp);
    minuteSet.add(Math.floor(t.getTime() / 60_000));
    daySet.add(t.toISOString().slice(0, 10));
  }

  await db.transaction(async (trx) => {
    const CHUNK = 1000;
    for (let i = 0; i < promote.length; i += CHUNK) {
      await trx('game_tracker_snapshots').insert(
        promote.slice(i, i + CHUNK).map((r) => ({
          game_tracker_id: tracker.id,
          channel_id: channel!.id,
          timestamp: r.timestamp,
          concurrent_viewers: r.concurrent_viewers,
          platform: 'youtube',
          language: normLang(r.language),
          region: null,
          stream_id: r.video_id,
          stream_title: r.stream_title,
          game_name: tracker.name,
          started_at: r.started_at,
        })),
      );
    }
    await Quarantine.discardChannel(tracker.id, channelIdentifier, trx);
  });

  // Make the channel an active member of the tracker immediately — if its
  // stream already ended, no future poll cycle would do this for us.
  await GameTrackerChannelModel.upsert(tracker.id, channel.id, 'auto_discovered');

  // Past days may already be rolled up (nightly settle only re-covers two
  // days back); recompute any day we just backfilled. Idempotent.
  const today = utcDay(0);
  for (const day of [...daySet].sort()) {
    if (day >= today) continue;
    try {
      await rollupDay(day);
    } catch (err) {
      logger.warn(`[YTQuarantine] rollup of ${day} after promotion failed`, {
        error: (err as Error).message,
      });
    }
  }

  logger.info(
    `[YTQuarantine] ${tracker.slug}/${channelIdentifier}: promoted ${promote.length} held rows (${minuteSet.size} min), skipped ${skip.length} (scope '${scope}')`,
  );
  return { promoted: promote.length, skipped: skip.length, minutes: minuteSet.size };
}
