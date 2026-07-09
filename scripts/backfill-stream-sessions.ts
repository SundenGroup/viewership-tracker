#!/usr/bin/env npx tsx
/**
 * Backfill stream_sessions from historical game_tracker_snapshots.
 *
 * Derives sessions the same way the old on-read endpoint did — per
 * channel, ordered by timestamp, split whenever stream_id changes OR
 * the gap between consecutive snapshots exceeds 10 minutes — then
 * upserts them as ended rows and computes the same finals as the live
 * close pass (minutes_live, ccv_minutes, avg/peak, chat volume,
 * followers_end). Legacy snapshots with NULL stream_id get a synthetic
 * 'legacy-' || md5(channel_id || first timestamp) id per segment.
 *
 * Idempotent: re-runs upsert the same (tracker, channel, stream_id)
 * keys and recompute identical finals. Safe to run while trackers are
 * live — a session marked 'ended' here is resurrected by the next poll
 * cycle's upsert if the stream is still going.
 *
 * Usage:
 *   npx tsx scripts/backfill-stream-sessions.ts <tracker-slug>
 *   npx tsx scripts/backfill-stream-sessions.ts --all
 */
import db from '../src/utils/db';
import * as GameTrackerModel from '../src/models/game-tracker';
import * as StreamSessionModel from '../src/models/stream-session';

const FINALIZE_CHUNK = 500;

export async function backfillTracker(
  tracker: GameTrackerModel.GameTracker,
): Promise<{ sessions: number; channels: number }> {
  // Derive session segments and upsert them in one statement. The unique
  // key is (tracker, channel, stream_id); the same stream_id can span a
  // >10-min gap (two derived segments), so we keep the latest segment —
  // its started_at still COALESCEs back to the platform's broadcast
  // start, and finals are computed over [started_at, ended_at] anyway.
  const result = await db.raw<{ rows: Array<{ id: string; channel_id: string }> }>(
    `
    WITH ordered AS (
      SELECT id, channel_id, stream_id, "timestamp", stream_title, game_name, started_at,
             LAG("timestamp")  OVER w AS prev_ts,
             LAG(stream_id)    OVER w AS prev_stream_id,
             LAG(stream_title) OVER w AS prev_title
      FROM game_tracker_snapshots
      WHERE game_tracker_id = ?
      WINDOW w AS (PARTITION BY channel_id ORDER BY "timestamp", id)
    ),
    flagged AS (
      SELECT *,
             CASE WHEN prev_ts IS NULL
                    OR "timestamp" - prev_ts > interval '10 minutes'
                    OR stream_id IS DISTINCT FROM prev_stream_id
                  THEN 1 ELSE 0 END AS is_break
      FROM ordered
    ),
    grouped AS (
      SELECT *,
             SUM(is_break) OVER (
               PARTITION BY channel_id ORDER BY "timestamp", id
               ROWS UNBOUNDED PRECEDING
             ) AS grp
      FROM flagged
    ),
    derived AS (
      SELECT
        channel_id,
        grp,
        COALESCE(MAX(stream_id), 'legacy-' || md5(channel_id::text || MIN("timestamp")::text)) AS stream_id,
        COALESCE(MIN(started_at), MIN("timestamp")) AS started_at,
        MAX("timestamp") AS last_ts,
        COALESCE(
          jsonb_agg(jsonb_build_object('title', stream_title, 'at', "timestamp") ORDER BY "timestamp")
            FILTER (WHERE stream_title IS NOT NULL
                      AND (is_break = 1 OR stream_title IS DISTINCT FROM prev_title)),
          '[]'::jsonb
        ) AS titles,
        (array_agg(game_name ORDER BY "timestamp" DESC) FILTER (WHERE game_name IS NOT NULL))[1] AS category
      FROM grouped
      GROUP BY channel_id, grp
    ),
    dedup AS (
      SELECT DISTINCT ON (channel_id, stream_id) *
      FROM derived
      ORDER BY channel_id, stream_id, last_ts DESC
    )
    INSERT INTO stream_sessions
      (game_tracker_id, channel_id, stream_id, started_at, last_seen_at, ended_at,
       status, titles, category, followers_start)
    SELECT ?, d.channel_id, d.stream_id, d.started_at, d.last_ts, d.last_ts,
           'ended', d.titles, d.category, f.followers
    FROM dedup d
    LEFT JOIN LATERAL (
      SELECT followers FROM channel_follower_snapshots
      WHERE channel_id = d.channel_id AND ts <= d.started_at
      ORDER BY ts DESC LIMIT 1
    ) f ON true
    ON CONFLICT (game_tracker_id, channel_id, stream_id) DO UPDATE SET
      started_at   = EXCLUDED.started_at,
      last_seen_at = EXCLUDED.last_seen_at,
      ended_at     = EXCLUDED.ended_at,
      status       = 'ended',
      titles       = EXCLUDED.titles,
      category     = EXCLUDED.category
    RETURNING id, channel_id
    `,
    [tracker.id, tracker.id],
  );
  const rows = result.rows;

  // Same finals as the live close pass, over each session's window.
  for (let i = 0; i < rows.length; i += FINALIZE_CHUNK) {
    await StreamSessionModel.finalizeSessions(
      rows.slice(i, i + FINALIZE_CHUNK).map((r) => r.id),
    );
  }

  return { sessions: rows.length, channels: new Set(rows.map((r) => r.channel_id)).size };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/backfill-stream-sessions.ts <tracker-slug> | --all');
    process.exit(1);
  }

  try {
    let trackers: GameTrackerModel.GameTracker[];
    if (arg === '--all') {
      trackers = await GameTrackerModel.findAll();
    } else {
      const tracker = await GameTrackerModel.findBySlug(arg);
      if (!tracker) {
        console.error(`Tracker not found: "${arg}"`);
        process.exit(1);
      }
      trackers = [tracker];
    }

    let totalSessions = 0;
    for (const tracker of trackers) {
      const { sessions, channels } = await backfillTracker(tracker);
      totalSessions += sessions;
      console.log(`${tracker.slug}: ${sessions} session(s) upserted across ${channels} channel(s)`);
    }
    console.log(`Done — ${totalSessions} session(s) across ${trackers.length} tracker(s).`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
