#!/usr/bin/env npx tsx
/**
 * VOD chat-replay backfill — completes chat evidence for sessions the
 * live collector under-covered.
 *
 * The collector can only sit in so many chats at once, so grade-eligible
 * sessions (50+ avg CCV, 30+ min) sometimes end with chat evidence below
 * the scorer's 50% coverage gate. Twitch keeps full chat replay on past
 * broadcasts, so for those sessions we can do better than sampling:
 *
 *   1. find the archive VOD that covers the session window
 *      (Helix /videos — we already hold app credentials);
 *   2. page the complete replay via the public GQL endpoint
 *      (VideoCommentsByOffsetOrCursor — same data the web player shows);
 *   3. rebuild chat_minute_rollup for the window from the replay
 *      (DELETE + INSERT in one txn — replay is authoritative, additive
 *      merging with partial live rows would double-count);
 *   4. write a chat_watch_intervals row with source='vod' spanning the
 *      whole session — replay is complete by definition, so every silent
 *      minute is a verified zero;
 *   5. re-run finalizeSessions (messages / unique_chatters) and score.
 *
 * Sessions with no VOD (channel doesn't keep past broadcasts) or an
 * unavailable replay are recorded in vod_chat_backfills so they are
 * never refetched. Twitch-only for now: YouTube's eligible channels are
 * few and near-always covered live; Kick has no replay API.
 *
 * Usage:
 *   npx tsx scripts/vod-chat-backfill.ts --once      # single pass
 *   npx tsx scripts/vod-chat-backfill.ts --dry-run   # report, no writes
 *   pm2 start "npx tsx scripts/vod-chat-backfill.ts" --name vod-chat-backfill
 *
 * Environment:
 *   VOD_BACKFILL_DISABLED=1     — kill switch (process idles)
 *   VOD_BACKFILL_LIMIT          — max sessions per pass (default 200)
 *   VOD_BACKFILL_LOOKBACK_H     — how far back to look (default 48)
 *   VOD_BACKFILL_MIN_AGE_MIN    — skip sessions ended more recently than
 *                                 this; replay finalizes with a lag (60)
 *   VOD_BACKFILL_INTERVAL_MIN   — loop cadence (default 360)
 *   VOD_BACKFILL_PAGE_BUDGET    — max GQL pages per pass (default 3000)
 */
import axios from 'axios';
import db from '../src/utils/db';
import { TwitchAdapter } from '../src/adapters/twitch';
import { finalizeSessions } from '../src/models/stream-session';
import { scoreSessions } from '../src/services/stream-health';

const DISABLED = process.env.VOD_BACKFILL_DISABLED === '1';
const LIMIT = clampInt(process.env.VOD_BACKFILL_LIMIT, 200, 1, 2000);
const LOOKBACK_H = clampInt(process.env.VOD_BACKFILL_LOOKBACK_H, 48, 1, 24 * 14);
const MIN_AGE_MIN = clampInt(process.env.VOD_BACKFILL_MIN_AGE_MIN, 60, 0, 24 * 60);
const INTERVAL_MIN = clampInt(process.env.VOD_BACKFILL_INTERVAL_MIN, 360, 10, 24 * 60);
const PAGE_BUDGET = clampInt(process.env.VOD_BACKFILL_PAGE_BUDGET, 3000, 50, 50_000);
const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry-run');

const PAGE_DELAY_MS = 300;
const SESSION_DELAY_MS = 750;
const MAX_PAGES_PER_SESSION = 500;
/** Scorer's gate — sessions already at/above this coverage will grade on
 *  their own; only the ones below it are worth a replay fetch. */
const COVERAGE_GATE = 0.5;

const GQL_URL = 'https://gql.twitch.tv/gql';
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // public web client
const COMMENTS_QUERY_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [VodBackfill] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const twitch = new TwitchAdapter();

interface CandidateRow {
  id: string;
  channel_id: string;
  channel_identifier: string;
  channel_metadata: Record<string, unknown> | null;
  started_at: Date;
  ended_at: Date;
  minutes_live: number;
  peak_ccv: number;
}

/**
 * Grade-eligible, ungraded, unattempted twitch sessions whose chat
 * evidence (message-minutes or live watch intervals) is under the
 * scorer's gate. The two coverage terms are checked separately — their
 * union can only be larger, so a false positive costs one redundant
 * (and strictly richer) replay fetch, never a miss.
 */
async function findCandidates(): Promise<CandidateRow[]> {
  const res = await db.raw(
    `
    SELECT s.id, s.channel_id, c.channel_identifier, c.metadata AS channel_metadata,
           s.started_at, s.ended_at, s.minutes_live, s.peak_ccv
    FROM stream_sessions s
    JOIN channels c ON c.id = s.channel_id
    WHERE c.platform = 'twitch'
      AND s.status = 'ended'
      AND s.ended_at >= now() - make_interval(hours => ?)
      AND s.ended_at <= now() - make_interval(mins => ?)
      AND s.avg_ccv >= 50
      AND s.minutes_live >= 30
      AND s.health_grade IS NULL
      AND NOT EXISTS (SELECT 1 FROM vod_chat_backfills b WHERE b.session_id = s.id)
      AND (
        SELECT COUNT(*) FROM chat_minute_rollup r
        WHERE r.channel_id = s.channel_id
          AND r.minute >= date_trunc('minute', s.started_at)
          AND r.minute <= s.ended_at
      ) < ? * s.minutes_live
      AND COALESCE((
        SELECT SUM(EXTRACT(epoch FROM (
          LEAST(COALESCE(wi.ended_at, wi.last_seen_at), s.ended_at)
          - GREATEST(wi.started_at, s.started_at)
        )) / 60)
        FROM chat_watch_intervals wi
        WHERE wi.channel_id = s.channel_id
          AND wi.started_at <= s.ended_at
          AND COALESCE(wi.ended_at, wi.last_seen_at) >= s.started_at
      ), 0) < ? * s.minutes_live
    ORDER BY s.peak_ccv DESC
    LIMIT ?
    `,
    [LOOKBACK_H, MIN_AGE_MIN, COVERAGE_GATE, COVERAGE_GATE, LIMIT],
  );
  return (res as { rows: CandidateRow[] }).rows;
}

/** Cached twitch user id (channels.metadata.twitch_user_id), Helix on miss. */
async function resolveUserId(row: CandidateRow): Promise<string | null> {
  const cached = row.channel_metadata?.twitch_user_id;
  if (typeof cached === 'string' && cached) return cached;
  const login = row.channel_identifier.toLowerCase();
  const users = await twitch.getUsersByLogin([login]);
  const id = users[0]?.id ?? null;
  if (id && !DRY) {
    await db('channels')
      .where('id', row.channel_id)
      .update({ metadata: db.raw(`jsonb_set(COALESCE(metadata, '{}'::jsonb), '{twitch_user_id}', ?::jsonb)`, [JSON.stringify(id)]) });
  }
  return id;
}

interface ReplayPage {
  comments: Array<{ offsetSeconds: number; commenterId: string | null }>;
  nextCursor: string | null;
}

async function fetchReplayPage(videoId: string, opts: { offset?: number; cursor?: string }): Promise<ReplayPage | null> {
  const variables = opts.cursor
    ? { videoID: videoId, cursor: opts.cursor }
    : { videoID: videoId, contentOffsetSeconds: Math.max(0, opts.offset ?? 0) };
  const { data } = await axios.post(
    GQL_URL,
    {
      operationName: 'VideoCommentsByOffsetOrCursor',
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_QUERY_HASH } },
    },
    { headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json' }, timeout: 20_000 },
  );
  const comments = data?.data?.video?.comments;
  if (!comments || !Array.isArray(comments.edges)) return null;
  const out: ReplayPage = { comments: [], nextCursor: null };
  for (const edge of comments.edges) {
    const node = edge?.node;
    if (!node || typeof node.contentOffsetSeconds !== 'number') continue;
    out.comments.push({
      offsetSeconds: node.contentOffsetSeconds,
      commenterId: node.commenter?.id ?? null,
    });
    if (edge.cursor) out.nextCursor = edge.cursor;
  }
  if (!comments.pageInfo?.hasNextPage) out.nextCursor = null;
  return out;
}

interface MinuteAgg {
  messages: number;
  chatters: Set<string>;
}

async function processSession(row: CandidateRow, budget: { pages: number }): Promise<{ status: string; detail?: string; messages?: number; minutes?: number }> {
  const userId = await resolveUserId(row);
  if (!userId) return { status: 'error', detail: 'twitch login not resolvable' };

  const startMs = new Date(row.started_at).getTime();
  const endMs = new Date(row.ended_at).getTime();

  const vods = await twitch.getArchiveVideos(userId, 20);
  // The VOD must begin at/before the session start and last to (nearly)
  // its end — 120s slack for encoder lag at the tail.
  const vod = vods.find((v) => {
    const vs = v.createdAt.getTime();
    return vs <= startMs + 60_000 && vs + v.durationSeconds * 1000 >= endMs - 120_000;
  });
  if (!vod) return { status: 'no_vod', detail: `${vods.length} archive vod(s), none covering the window` };

  const vodStartMs = vod.createdAt.getTime();
  const startOffset = Math.max(0, Math.floor((startMs - vodStartMs) / 1000) - 60);
  const endOffset = Math.ceil((endMs - vodStartMs) / 1000) + 60;

  const perMinute = new Map<number, MinuteAgg>();
  let totalMessages = 0;
  let cursor: string | null = null;
  let pages = 0;
  let lastOffset = startOffset;

  for (;;) {
    if (pages >= MAX_PAGES_PER_SESSION || budget.pages <= 0) {
      return { status: 'error', detail: `page budget exhausted at offset ${lastOffset}s of ${endOffset}s` };
    }
    let page: ReplayPage | null;
    try {
      page = await fetchReplayPage(vod.id, cursor ? { cursor } : { offset: startOffset });
    } catch (err) {
      return { status: 'replay_unavailable', detail: (err as Error).message };
    }
    pages++;
    budget.pages--;
    if (page === null) {
      // First page null = replay disabled/expired; mid-stream null = done.
      if (pages === 1) return { status: 'replay_unavailable', detail: 'no comments payload' };
      break;
    }
    for (const c of page.comments) {
      lastOffset = c.offsetSeconds;
      if (c.offsetSeconds < startOffset || c.offsetSeconds > endOffset) continue;
      const ts = vodStartMs + c.offsetSeconds * 1000;
      if (ts < startMs - 60_000 || ts > endMs + 60_000) continue;
      const minuteMs = Math.floor(ts / 60_000) * 60_000;
      let agg = perMinute.get(minuteMs);
      if (!agg) {
        agg = { messages: 0, chatters: new Set() };
        perMinute.set(minuteMs, agg);
      }
      agg.messages++;
      totalMessages++;
      if (c.commenterId) agg.chatters.add(c.commenterId);
    }
    if (!page.nextCursor || lastOffset > endOffset) break;
    cursor = page.nextCursor;
    await sleep(PAGE_DELAY_MS);
  }

  if (DRY) {
    return { status: 'ok', detail: `dry-run (${pages} pages)`, messages: totalMessages, minutes: perMinute.size };
  }

  // Replace the window's rollup with the authoritative replay counts and
  // mark the whole span as verified coverage.
  await db.transaction(async (trx) => {
    await trx('chat_minute_rollup')
      .where('channel_id', row.channel_id)
      .where('minute', '>=', trx.raw(`date_trunc('minute', ?::timestamptz)`, [row.started_at]))
      .where('minute', '<=', row.ended_at)
      .delete();
    const rows = [...perMinute.entries()].map(([minuteMs, agg]) => ({
      channel_id: row.channel_id,
      minute: new Date(minuteMs).toISOString(),
      messages: agg.messages,
      chatters: agg.chatters.size,
    }));
    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += 500) {
        await trx('chat_minute_rollup').insert(rows.slice(i, i + 500));
      }
    }
    await trx('chat_watch_intervals').insert({
      channel_id: row.channel_id,
      started_at: trx.raw(`date_trunc('minute', ?::timestamptz)`, [row.started_at]),
      last_seen_at: row.ended_at,
      ended_at: row.ended_at,
      source: 'vod',
    });
  });
  await finalizeSessions([row.id]);
  return { status: 'ok', messages: totalMessages, minutes: perMinute.size };
}

async function runPass(): Promise<void> {
  const candidates = await findCandidates();
  if (candidates.length === 0) {
    log('no under-covered eligible sessions — nothing to do');
    return;
  }
  log(`${candidates.length} candidate session(s)${DRY ? ' (dry run)' : ''}`);

  const budget = { pages: PAGE_BUDGET };
  const okIds: string[] = [];
  const counts: Record<string, number> = {};
  for (const row of candidates) {
    let result: { status: string; detail?: string; messages?: number; minutes?: number };
    try {
      result = await processSession(row, budget);
    } catch (err) {
      result = { status: 'error', detail: (err as Error).message };
    }
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    if (result.status === 'ok') {
      okIds.push(row.id);
      log(
        `  ${row.channel_identifier}: ${result.messages} msg over ${result.minutes} chat-minute(s) ` +
          `(session ${row.minutes_live} min, peak ${row.peak_ccv})`,
      );
    } else {
      log(`  ${row.channel_identifier}: ${result.status}${result.detail ? ` — ${result.detail}` : ''}`);
    }
    if (!DRY) {
      await db('vod_chat_backfills')
        .insert({
          session_id: row.id,
          status: result.status,
          detail: result.detail ?? null,
          messages: result.messages ?? null,
          minutes: result.minutes ?? null,
        })
        .onConflict('session_id')
        .merge();
    }
    if (budget.pages <= 0) {
      log('page budget exhausted — remaining candidates wait for the next pass');
      break;
    }
    await sleep(SESSION_DELAY_MS);
  }

  log(`pass complete: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (okIds.length > 0 && !DRY) {
    const scored = await scoreSessions(okIds);
    log(`scoring: ${scored.scored}/${scored.candidates} graded`);
  }
}

async function main(): Promise<void> {
  if (DISABLED) {
    log('disabled via VOD_BACKFILL_DISABLED=1 — idling');
    if (ONCE) process.exit(0);
    setInterval(() => {}, 1 << 30);
    return;
  }
  await db.raw('SELECT 1');
  log(
    `starting — limit ${LIMIT}/pass, lookback ${LOOKBACK_H}h, min age ${MIN_AGE_MIN}m, ` +
      `page budget ${PAGE_BUDGET}, ${ONCE ? 'single pass' : `every ${INTERVAL_MIN}m`}${DRY ? ', DRY RUN' : ''}`,
  );
  await runPass();
  if (ONCE || DRY) {
    await db.destroy();
    process.exit(0);
  }
  setInterval(() => {
    runPass().catch((err) => log(`pass ERROR: ${(err as Error).message}`));
  }, INTERVAL_MIN * 60_000);
}

main().catch(async (err) => {
  log(`fatal: ${(err as Error).message}`);
  await db.destroy().catch(() => {});
  process.exit(1);
});
