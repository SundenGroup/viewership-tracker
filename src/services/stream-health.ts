/**
 * Stream health scorer — Stream Integrity Signals Phase 1.
 *
 * Plan: docs/plans/2026-07-09-stream-integrity-signals.md.
 *
 * Scores ENDED stream_sessions rows on a 0-100 composite built ONLY from
 * data we already collect (per-minute CCV, chat_minute_rollup, follower
 * snapshots). Positioning: health first, accusation never — every grade
 * ships with plain-language evidence, and a session without chat coverage
 * gets NO score (never a zero).
 *
 * Eligibility (a session is scored only when ALL hold):
 *   - status = 'ended', avg_ccv ≥ 50, minutes_live ≥ 30
 *   - chat evidence: ≥ 50% of the session's snapshot minutes have either
 *     a chat_minute_rollup row (a message arrived) or a chat_watch_intervals
 *     overlap (the collector was subscribed — a watched-silent minute is a
 *     real zero, not missing data). The collector selects the top ~600
 *     live channels across trackers, so smaller sessions can still
 *     legitimately lack coverage.
 *
 * Transitional note (2026-08-10): sessions ended before watch intervals
 * existed contribute cohort engagement ratios computed over message-minutes
 * only, which are biased high vs the watched basis. The bias fades as the
 * 30-day cohort refills; it can only make quiet targets look worse, never
 * better, which is the safe direction for a suspicion score.
 *
 * Cohort = scored-eligible sessions of the same tracker, avg_ccv size
 * band (50-200 / 200-1k / 1k-5k / 5k-20k / 20k+) AND platform when that
 * slice has ≥ MIN_COHORT_N sessions (chat culture differs — YouTube
 * chats far less per viewer than Twitch), falling back to the mixed
 * tracker+band cohort otherwise; ended in the last 30 days.
 * Cohort-relative baselines are the whole point: 3% chat ratio is normal
 * at 50k CCV and damning at 300.
 *
 * YouTube and TikTok follower conversion is always neutral: both report
 * rounded follower counts (11.0k stays 11.0k through real growth, and
 * the bigger the channel the coarser the rounding), so their deltas are
 * false zeros, not data.
 *
 * Grades are a SUSPICION verdict, not a class rank (the percentile
 * subscores are zero-sum — half of all streams are below median by
 * construction, and that alone must not read as an accusation). The flag
 * gates are applied to the STORED SCORE (applyGradeGates) so the letter
 * is always a pure function of the number — same score, same letter:
 *   - no flags        → score floored into the C band ("typical")
 *   - D band          → requires at least one flag
 *   - F band          → requires ≥2 strong flags (low_engagement,
 *                       chat_unresponsive, flat_curve), OR a single
 *                       critical flag: extremely low chat↔viewer ratio
 *                       (bottom 5% AND under 1/3 of cohort typical) caps
 *                       the score at 39 on its own.
 * When a gate moves the score, the pre-gate sum is kept in
 * evidence.rawScore (subscores may not sum to the stored score).
 *
 * Subscores (composite = sum, 0-100):
 *   - Engagement (40): percentile of mean(chatters/ccv per minute) within
 *     the cohort, scaled to 40. Cohort < MIN_COHORT_N → neutral 20.
 *   - Curve organicness (30): start at 30 and deduct —
 *       -15 unnaturally flat (session CV < 25% of cohort median CV),
 *       -10 step discontinuity (any |Δccv| > 35% of level within ≤2 min,
 *           away from session edges; one deduction regardless of count),
 *       -5  spike above the cohort p99 minute-rise with no title change
 *           within ±3 minutes.
 *   - Follower conversion (15): percentile of followers gained per 1k
 *     viewer-minutes vs cohort. Null follower data (or cohort too small)
 *     → neutral 10.
 *   - Spike response (15): Pearson corr of Δccv vs Δchatters across the
 *     session. corr ≥ 0.2 → 15, -0.1 ≤ corr < 0.2 → 8 (near-zero is
 *     noise), corr < -0.1 with spikes present → 0, no spikes → neutral 10.
 *
 * All SQL is set-based (one cohort-stats statement per run); only the
 * per-target curve analysis runs in JS, over per-minute arrays fetched in
 * one query per chunk.
 */

import db from '../utils/db';
import logger from '../utils/logger';
import type { HealthEvidence, HealthFlag } from '../models/stream-session';

// ── Eligibility gates ──────────────────────────────────────────────────
const MIN_AVG_CCV = 50;
const MIN_MINUTES = 30;
const MIN_CHAT_COVERAGE = 0.5; // fraction of snapshot minutes with a chat row

// ── Cohort ─────────────────────────────────────────────────────────────
const COHORT_DAYS = 30;
/** Below this many cohort sessions a percentile is noise — go neutral. */
const MIN_COHORT_N = 5;
/** A cohort must also span this many DISTINCT channels — six sessions of
 *  one channel is a mirror, not a baseline. */
const MIN_COHORT_CHANNELS = 3;

// ── Subscore weights ───────────────────────────────────────────────────
const ENGAGEMENT_MAX = 40;
const CURVE_MAX = 30;
const FOLLOWERS_MAX = 15;
const RESPONSE_MAX = 15;

// ── Curve analysis knobs ───────────────────────────────────────────────
const FLAT_CV_RATIO = 0.25;        // session CV < 25% of cohort median CV → flat
const STEP_DELTA_RATIO = 0.35;     // |Δccv| > 35% of level → step candidate
const STEP_MAX_GAP_MIN = 2;        // ... when the two samples are ≤ 2 min apart
const EDGE_START_MINUTES = 15;     // ignore steps/spikes in the first 15 min —
                                   // scheduled broadcasts ramp in blocks
const EDGE_END_MINUTES = 5;        // ... and the last 5 min of a session
const RISE_LEVEL_FLOOR = 50;       // ignore rises off a base < 50 ccv (tiny
                                   // denominators make 10→45 read as +350%)
const SPIKE_TITLE_WINDOW_MS = 3 * 60_000; // a title change within ±3 min explains a spike
const FALLBACK_SPIKE_RISE = 0.5;   // spike threshold when the cohort p99 is unavailable
const CORR_NOISE_FLOOR = -0.1;     // corr in [-0.1, 0) is statistical noise, not
                                   // "chat moved oppositely" — score it neutral

// ── Grade gating ───────────────────────────────────────────────────────
/** Flags weighty enough that two together justify an F. */
const STRONG_FLAGS = new Set(['low_engagement', 'chat_unresponsive', 'flat_curve']);
/** Extreme chat↔viewer ratio: bottom N% of cohort AND under this fraction
 *  of the cohort's typical ratio → critical flag → F on its own. */
const EXTREME_ENG_PCT = 5;
const EXTREME_ENG_RATIO = 1 / 3;

/** How many target sessions to fetch per-minute arrays for at a time. */
const CURVE_CHUNK = 200;

export type SizeBand = '50-200' | '200-1k' | '1k-5k' | '5k-20k' | '20k+';

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** A ≥85, B ≥70, C ≥55, D ≥40, F <40. */
export function gradeForScore(score: number): HealthGrade {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Flag gates, applied to the SCORE so the letter stays a pure function of
 * the number (a 36 must always be the same letter — score and grade
 * disagreeing destroys credibility). D and F are reserved for streams
 * with actual red flags; percentile rank alone can only sink a stream to
 * the bottom of the C band:
 *   - critical flag        → capped into the F band (≤39)
 *   - no flags             → floored into the C band (≥55)
 *   - no two strong flags  → floored into the D band (≥40)
 */
export function applyGradeGates(score: number, flags: HealthFlag[]): number {
  if (flags.some((f) => f.severity === 'critical')) return Math.min(score, 39);
  if (flags.length === 0) return Math.max(score, 55);
  if (score < 40 && flags.filter((f) => STRONG_FLAGS.has(f.kind)).length < 2) return 40;
  return score;
}

export interface ScoreRunResult {
  /** Ended sessions that passed the cheap gates (avg ccv, duration). */
  candidates: number;
  /** Sessions actually scored (candidates with chat coverage). */
  scored: number;
  /** Candidates left unscored for lack of chat coverage (nulls kept). */
  skippedNoChat: number;
  durationMs: number;
}

/** The SQL twin of bandFor() — keep the two in lockstep. */
const BAND_SQL = `CASE WHEN avg_ccv < 200 THEN '50-200'
                       WHEN avg_ccv < 1000 THEN '200-1k'
                       WHEN avg_ccv < 5000 THEN '1k-5k'
                       WHEN avg_ccv < 20000 THEN '5k-20k'
                       ELSE '20k+' END`;

function bandFor(avgCcv: number): SizeBand {
  if (avgCcv < 200) return '50-200';
  if (avgCcv < 1000) return '200-1k';
  if (avgCcv < 5000) return '1k-5k';
  if (avgCcv < 20000) return '5k-20k';
  return '20k+';
}

/** The next band down — the borrow target when a band has no real cohort. */
function bandDown(band: SizeBand): SizeBand | null {
  switch (band) {
    case '20k+': return '5k-20k';
    case '5k-20k': return '1k-5k';
    case '1k-5k': return '200-1k';
    case '200-1k': return '50-200';
    default: return null;
  }
}

// ── Internal shapes ────────────────────────────────────────────────────

interface Candidate {
  id: string;
  game_tracker_id: string;
  tracker_slug: string;
  channel_id: string;
  platform: string;
  started_at: Date;
  ended_at: Date;
  avg_ccv: number;
  ccv_minutes: number;
  followers_start: number | null;
  followers_end: number | null;
  titles: Array<{ title: string; at: string }>;
}

interface TargetStats {
  engRatio: number;        // mean(chatters/ccv) over minutes with both
  cv: number | null;       // stddev/mean of per-minute ccv
  convPer1k: number | null;
  snapMinutes: number;
  chatMinutes: number;
}

interface CohortSession {
  ch: string;
  eng: number;
  conv: number | null;
  cv: number | null;
}

interface CohortStats {
  p99Rise: number | null;
  sessions: CohortSession[];
}

/** A target channel's view of a cohort: everyone else's sessions. */
interface CohortView {
  n: number;
  engs: number[];
  convs: number[];
  medianCv: number | null;
}

/**
 * Baselines a channel may be judged against: the cohort MINUS its own
 * sessions, and only when what remains spans enough sessions and enough
 * distinct channels to be a real peer group.
 */
function viewFor(cohort: CohortStats | undefined, channelId: string): CohortView | null {
  if (!cohort) return null;
  const others = cohort.sessions.filter((s) => s.ch !== channelId);
  const channels = new Set(others.map((s) => s.ch));
  if (others.length < MIN_COHORT_N || channels.size < MIN_COHORT_CHANNELS) return null;
  const cvs = others.map((s) => s.cv).filter((v): v is number => v != null);
  return {
    n: others.length,
    engs: others.map((s) => s.eng),
    convs: others.map((s) => s.conv).filter((v): v is number => v != null),
    medianCv: cvs.length > 0 ? median(cvs) : null,
  };
}

interface MinutePoint {
  t: number;               // epoch ms of the minute
  ccv: number;
  chatters: number | null; // null = no chat row for this minute
}

/**
 * Ids of ended sessions that passed the cheap scoring gates and ended
 * within the last N hours. The cron jobs and the backfill script resolve
 * their windows through this so scoreSessions always receives a tight
 * id list.
 */
export async function sessionIdsEndedWithin(hours: number): Promise<string[]> {
  const rows = await db('stream_sessions')
    .where('status', 'ended')
    .whereNotNull('ended_at')
    .where('ended_at', '>=', new Date(Date.now() - hours * 3_600_000))
    .where('avg_ccv', '>=', MIN_AVG_CCV)
    .where('minutes_live', '>=', MIN_MINUTES)
    .pluck('id');
  return rows as string[];
}

/**
 * Score a batch of sessions (idempotent — re-running recomputes the same
 * columns). With no argument, scores eligible sessions ended in the last
 * 7 days. Sessions without chat coverage are skipped, never zeroed.
 */
export async function scoreSessions(sessionIds?: string[]): Promise<ScoreRunResult> {
  const startedMs = Date.now();
  const done = (candidates: number, scored: number): ScoreRunResult => ({
    candidates,
    scored,
    skippedNoChat: candidates - scored,
    durationMs: Date.now() - startedMs,
  });
  if (sessionIds && sessionIds.length === 0) return done(0, 0);

  // ── 1. Candidates: cheap gates + metadata for evidence text ──────────
  let q = db('stream_sessions as s')
    .join('game_trackers as gt', 'gt.id', 's.game_tracker_id')
    .where('s.status', 'ended')
    .whereNotNull('s.ended_at')
    .where('s.avg_ccv', '>=', MIN_AVG_CCV)
    .where('s.minutes_live', '>=', MIN_MINUTES)
    .join('channels as c', 'c.id', 's.channel_id')
    .select(
      's.id', 's.game_tracker_id', 'gt.slug as tracker_slug', 's.channel_id',
      db.raw('c.platform::text as platform'),
      's.started_at', 's.ended_at', 's.avg_ccv', 's.ccv_minutes',
      's.followers_start', 's.followers_end', 's.titles',
    );
  q = sessionIds
    ? q.whereRaw('s.id = ANY(?::uuid[])', [sessionIds])
    : q.where('s.ended_at', '>=', db.raw(`now() - interval '7 days'`));
  const candidates: Candidate[] = (await q).map((r) => ({
    ...r,
    avg_ccv: Number(r.avg_ccv),
    ccv_minutes: Number(r.ccv_minutes),
    titles: r.titles ?? [],
  }));
  if (candidates.length === 0) return done(0, 0);

  const targetIds = candidates.map((c) => c.id);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  // (tracker, band) combos we need cohort baselines for — each target's
  // own band plus the band below it, so a lone giant (a band whose only
  // occupant is one channel) can still borrow the nearest honest peers.
  const comboKeys = new Set<string>();
  for (const c of candidates) {
    const band = bandFor(c.avg_ccv);
    comboKeys.add(`${c.game_tracker_id}|${band}`);
    const lower = bandDown(band);
    if (lower) comboKeys.add(`${c.game_tracker_id}|${lower}`);
  }
  const comboTrackers: string[] = [];
  const comboBands: string[] = [];
  for (const key of comboKeys) {
    const [trackerId, band] = key.split('|');
    comboTrackers.push(trackerId as string);
    comboBands.push(band as string);
  }

  // ── 2. Cohort + per-target stats in one set-based statement ──────────
  // The cohort scan windows over 30 days of per-minute data; SET LOCAL
  // lifts any server statement_timeout for exactly this transaction.
  const statsRows = await db.transaction(async (trx) => {
    await trx.raw('SET LOCAL statement_timeout = 0');
    const result = await trx.raw<{
      rows: Array<{ kind: 'cohort' | 'target'; tracker_id: string; band: string; payload: Record<string, unknown> }>;
    }>(
      `
      WITH combo AS (
        SELECT DISTINCT t.tracker_id, t.band
        FROM unnest(?::uuid[], ?::text[]) AS t(tracker_id, band)
      ),
      sess AS (
        SELECT s.id, s.game_tracker_id, s.channel_id, ch.platform::text AS platform,
               s.started_at, s.ended_at,
               s.avg_ccv, s.ccv_minutes, s.followers_start, s.followers_end,
               (${BAND_SQL}) AS band,
               (s.id = ANY(?::uuid[])) AS is_target,
               (s.ended_at >= now() - interval '${COHORT_DAYS} days') AS in_cohort
        FROM stream_sessions s
        JOIN channels ch ON ch.id = s.channel_id
        JOIN combo c
          ON c.tracker_id = s.game_tracker_id
         AND c.band = (${BAND_SQL})
        WHERE s.status = 'ended'
          AND s.ended_at IS NOT NULL
          AND s.avg_ccv >= ?
          AND s.minutes_live >= ?
          AND (s.ended_at >= now() - interval '${COHORT_DAYS} days' OR s.id = ANY(?::uuid[]))
          -- Cheap prefilter: skip the snapshots join entirely for sessions
          -- with no chat evidence at all — neither a message-minute nor a
          -- watch interval (most channels sit outside the collector's set).
          AND (
            EXISTS (
              SELECT 1 FROM chat_minute_rollup r
              WHERE r.channel_id = s.channel_id
                AND r.minute >= date_trunc('minute', s.started_at)
                AND r.minute <= s.ended_at
            )
            OR EXISTS (
              SELECT 1 FROM chat_watch_intervals wi
              WHERE wi.channel_id = s.channel_id
                AND wi.started_at <= s.ended_at
                AND COALESCE(wi.ended_at, wi.last_seen_at) >= s.started_at
            )
          )
      ),
      per_minute AS (
        SELECT se.id AS session_id, se.channel_id,
               date_trunc('minute', g."timestamp") AS minute,
               MAX(g.concurrent_viewers) AS ccv
        FROM sess se
        JOIN game_tracker_snapshots g
          ON g.game_tracker_id = se.game_tracker_id
         AND g.channel_id = se.channel_id
         AND g."timestamp" >= se.started_at
         AND g."timestamp" <= se.ended_at
        GROUP BY se.id, se.channel_id, date_trunc('minute', g."timestamp")
      ),
      minute_stats AS (
        -- A minute counts as chat evidence when a message arrived (rollup
        -- row) OR the collector was verifiably watching (interval overlap)
        -- — in the latter case silence is a real zero, not missing data.
        SELECT pm.session_id,
               COUNT(*)::int AS snap_minutes,
               COUNT(*) FILTER (WHERE r.chatters IS NOT NULL OR w.w IS NOT NULL)::int AS chat_minutes,
               AVG(pm.ccv)::numeric AS mean_ccv,
               stddev_samp(pm.ccv)::numeric AS sd_ccv,
               AVG(COALESCE(r.chatters, CASE WHEN w.w IS NOT NULL THEN 0 END)::numeric / pm.ccv)
                 FILTER (WHERE (r.chatters IS NOT NULL OR w.w IS NOT NULL) AND pm.ccv > 0) AS eng_ratio
        FROM per_minute pm
        LEFT JOIN chat_minute_rollup r
          ON r.channel_id = pm.channel_id AND r.minute = pm.minute
        LEFT JOIN LATERAL (
          SELECT 1 AS w FROM chat_watch_intervals wi
          WHERE wi.channel_id = pm.channel_id
            AND wi.started_at <= pm.minute
            AND COALESCE(wi.ended_at, wi.last_seen_at) >= pm.minute
          LIMIT 1
        ) w ON true
        GROUP BY pm.session_id
      ),
      eligible AS (
        SELECT se.id, se.channel_id, se.game_tracker_id, se.band, se.platform, se.is_target, se.in_cohort,
               ms.snap_minutes, ms.chat_minutes, ms.eng_ratio,
               CASE WHEN ms.mean_ccv > 0 THEN ms.sd_ccv / ms.mean_ccv END AS cv,
               -- YouTube and TikTok report follower counts rounded (11.0k
               -- stays 11.0k through real growth — and the bigger the
               -- channel, the coarser the rounding), so their "conversion"
               -- would be a false zero — treat as no data, score neutral.
               CASE WHEN se.followers_start IS NOT NULL AND se.followers_end IS NOT NULL
                         AND se.ccv_minutes > 0 AND se.platform NOT IN ('youtube', 'tiktok')
                    THEN (se.followers_end - se.followers_start)::numeric * 1000 / se.ccv_minutes
               END AS conv_per_1k
        FROM sess se
        JOIN minute_stats ms ON ms.session_id = se.id
        WHERE ms.eng_ratio IS NOT NULL
          AND ms.chat_minutes::numeric >= ?::numeric * ms.snap_minutes
      ),
      rise_vals AS (
        SELECT x.session_id, (x.ccv - x.prev_ccv)::numeric / x.prev_ccv AS rise
        FROM (
          SELECT pm.session_id, pm.ccv,
                 lag(pm.ccv) OVER (PARTITION BY pm.session_id ORDER BY pm.minute) AS prev_ccv
          FROM per_minute pm
        ) x
        WHERE x.prev_ccv >= ? AND x.ccv > x.prev_ccv
      ),
      -- GROUPING SETS emit each cohort twice: once per platform slice
      -- (chat culture differs — YouTube chats far less per viewer than
      -- Twitch) and once mixed. The scorer prefers the platform slice
      -- when it has enough sessions, else falls back to the mixed one.
      cohort_rise AS (
        SELECT e.game_tracker_id, e.band, e.platform,
               percentile_cont(0.99) WITHIN GROUP (ORDER BY rv.rise) AS p99_rise
        FROM rise_vals rv
        JOIN eligible e ON e.id = rv.session_id
        WHERE e.in_cohort
        GROUP BY GROUPING SETS ((e.game_tracker_id, e.band, e.platform), (e.game_tracker_id, e.band))
      ),
      cohort_agg AS (
        -- Per-session rows (not pre-aggregated arrays) so the scorer can
        -- exclude a target channel's OWN sessions from its baselines — a
        -- channel dominating its cohort must not be its own alibi.
        SELECT e.game_tracker_id, e.band, e.platform,
               jsonb_agg(jsonb_build_object(
                 'ch', e.channel_id, 'eng', e.eng_ratio, 'conv', e.conv_per_1k, 'cv', e.cv
               )) AS sessions
        FROM eligible e
        WHERE e.in_cohort
        GROUP BY GROUPING SETS ((e.game_tracker_id, e.band, e.platform), (e.game_tracker_id, e.band))
      )
      SELECT 'cohort' AS kind, ca.game_tracker_id::text AS tracker_id, ca.band,
             jsonb_build_object(
               'platform', ca.platform,
               'p99Rise', cr.p99_rise,
               'sessions', ca.sessions
             ) AS payload
      FROM cohort_agg ca
      LEFT JOIN cohort_rise cr
        ON cr.game_tracker_id = ca.game_tracker_id AND cr.band = ca.band
       AND cr.platform IS NOT DISTINCT FROM ca.platform
      UNION ALL
      SELECT 'target', e.game_tracker_id::text, e.band,
             jsonb_build_object(
               'id', e.id,
               'platform', e.platform,
               'engRatio', e.eng_ratio,
               'cv', e.cv,
               'convPer1k', e.conv_per_1k,
               'snapMinutes', e.snap_minutes,
               'chatMinutes', e.chat_minutes
             )
      FROM eligible e
      WHERE e.is_target
      `,
      [
        comboTrackers, comboBands,
        targetIds,
        MIN_AVG_CCV, MIN_MINUTES,
        targetIds,
        MIN_CHAT_COVERAGE,
        RISE_LEVEL_FLOOR,
      ],
    );
    return result.rows;
  });

  // Cohorts are keyed tracker|band|platform, with '*' for the mixed
  // (all-platform) slice the GROUPING SETS also emit.
  const cohorts = new Map<string, CohortStats>();
  const targets = new Map<string, TargetStats>();
  const targetBand = new Map<string, SizeBand>();
  for (const row of statsRows) {
    const p = row.payload;
    if (row.kind === 'cohort') {
      cohorts.set(`${row.tracker_id}|${row.band}|${(p.platform as string | null) ?? '*'}`, {
        p99Rise: p.p99Rise != null ? Number(p.p99Rise) : null,
        sessions: ((p.sessions as Array<Record<string, unknown>>) ?? []).map((s) => ({
          ch: String(s.ch),
          eng: Number(s.eng),
          conv: s.conv != null ? Number(s.conv) : null,
          cv: s.cv != null ? Number(s.cv) : null,
        })),
      });
    } else {
      targets.set(String(p.id), {
        engRatio: Number(p.engRatio),
        cv: p.cv != null ? Number(p.cv) : null,
        convPer1k: p.convPer1k != null ? Number(p.convPer1k) : null,
        snapMinutes: Number(p.snapMinutes),
        chatMinutes: Number(p.chatMinutes),
      });
      targetBand.set(String(p.id), row.band as SizeBand);
    }
  }

  const eligibleIds = targetIds.filter((id) => targets.has(id));
  if (eligibleIds.length === 0) {
    logger.info('[StreamHealth] no eligible sessions to score', {
      candidates: candidates.length,
    });
    return done(candidates.length, 0);
  }

  // ── 3. Curve analysis + write-back, in chunks ────────────────────────
  let scored = 0;
  for (let i = 0; i < eligibleIds.length; i += CURVE_CHUNK) {
    const chunk = eligibleIds.slice(i, i + CURVE_CHUNK);
    const minutesBySession = await fetchMinuteArrays(chunk);

    const ids: string[] = [];
    const scores: number[] = [];
    const grades: string[] = [];
    const evidences: string[] = [];
    for (const id of chunk) {
      const candidate = byId.get(id);
      const stats = targets.get(id);
      const minutes = minutesBySession.get(id) ?? [];
      if (!candidate || !stats || minutes.length < 3) continue;
      const band = targetBand.get(id) as SizeBand;
      const trackerId = candidate.game_tracker_id;
      const lower = bandDown(band);
      const platC = cohorts.get(`${trackerId}|${band}|${candidate.platform}`);
      const mixedC = cohorts.get(`${trackerId}|${band}|*`);
      const lowerC = lower ? cohorts.get(`${trackerId}|${lower}|*`) : undefined;
      // Every baseline excludes the target channel's OWN sessions — a
      // channel dominating its band must not be its own alibi.
      const platView = viewFor(platC, candidate.channel_id);
      const mixedView = viewFor(mixedC, candidate.channel_id);
      const lowerView = lower ? viewFor(lowerC, candidate.channel_id) : null;
      // Engagement/followers: platform slice → mixed band → borrowed lower
      // band (chat culture is platform-specific, and a lone giant still
      // deserves the nearest honest peers). The borrow shows in evidence
      // via the cohort's band name.
      let eng: { view: CohortView | null; platform: string; band: SizeBand };
      if (platView) eng = { view: platView, platform: candidate.platform, band };
      else if (mixedView) eng = { view: mixedView, platform: 'all', band };
      else if (lowerView) eng = { view: lowerView, platform: 'all', band: lower as SizeBand };
      else eng = { view: null, platform: 'all', band };
      // Curve shape is not platform-cultural — its baselines always come
      // from the mixed chain so a tiny platform slice can't dilute them.
      let shape: { medianCv: number | null; p99Rise: number | null; band: SizeBand };
      if (mixedView) shape = { medianCv: mixedView.medianCv, p99Rise: mixedC?.p99Rise ?? null, band };
      else if (lowerView) {
        shape = { medianCv: lowerView.medianCv, p99Rise: lowerC?.p99Rise ?? null, band: lower as SizeBand };
      } else shape = { medianCv: null, p99Rise: null, band };
      const { score, evidence } = scoreOne(candidate, stats, eng, shape, minutes);
      const gated = applyGradeGates(score, evidence.flags);
      if (gated !== score) evidence.rawScore = score;
      ids.push(id);
      scores.push(gated);
      grades.push(gradeForScore(gated));
      evidences.push(JSON.stringify(evidence));
    }
    if (ids.length === 0) continue;

    // The live close pass finalizes the same rows — retry a transient
    // deadlock rather than losing the whole batch.
    await withDeadlockRetry(() => db.raw(
      `
      UPDATE stream_sessions ss
      SET health_score = v.score,
          health_grade = v.grade,
          health_evidence = v.evidence::jsonb
      FROM unnest(?::uuid[], ?::int[], ?::text[], ?::text[]) AS v(id, score, grade, evidence)
      WHERE ss.id = v.id
      `,
      [ids, scores, grades, evidences],
    ));
    scored += ids.length;
  }

  const result = done(candidates.length, scored);
  logger.info('[StreamHealth] scoring pass complete', { ...result });
  return result;
}

/**
 * Per-minute (ccv, chatters) arrays for a chunk of sessions, one query.
 * chatters is 0 on watched-but-silent minutes (interval overlap, no
 * rollup row) and null only where the collector wasn't watching at all.
 */
async function fetchMinuteArrays(sessionIds: string[]): Promise<Map<string, MinutePoint[]>> {
  const result = await db.transaction(async (trx) => {
    await trx.raw('SET LOCAL statement_timeout = 0');
    return trx.raw<{
      rows: Array<{ session_id: string; minute: Date; ccv: number; chatters: number | null }>;
    }>(
      `
      WITH t AS (
        SELECT id, game_tracker_id, channel_id, started_at, ended_at
        FROM stream_sessions
        WHERE id = ANY(?::uuid[])
      ),
      pm AS (
        SELECT t.id AS session_id, t.channel_id,
               date_trunc('minute', g."timestamp") AS minute,
               MAX(g.concurrent_viewers)::int AS ccv
        FROM t
        JOIN game_tracker_snapshots g
          ON g.game_tracker_id = t.game_tracker_id
         AND g.channel_id = t.channel_id
         AND g."timestamp" >= t.started_at
         AND g."timestamp" <= t.ended_at
        GROUP BY t.id, t.channel_id, date_trunc('minute', g."timestamp")
      )
      SELECT pm.session_id, pm.minute, pm.ccv,
             COALESCE(r.chatters, CASE WHEN w.w IS NOT NULL THEN 0 END)::int AS chatters
      FROM pm
      LEFT JOIN chat_minute_rollup r
        ON r.channel_id = pm.channel_id AND r.minute = pm.minute
      LEFT JOIN LATERAL (
        SELECT 1 AS w FROM chat_watch_intervals wi
        WHERE wi.channel_id = pm.channel_id
          AND wi.started_at <= pm.minute
          AND COALESCE(wi.ended_at, wi.last_seen_at) >= pm.minute
        LIMIT 1
      ) w ON true
      ORDER BY pm.session_id, pm.minute
      `,
      [sessionIds],
    );
  });
  const map = new Map<string, MinutePoint[]>();
  for (const row of result.rows) {
    let arr = map.get(row.session_id);
    if (!arr) {
      arr = [];
      map.set(row.session_id, arr);
    }
    arr.push({
      t: new Date(row.minute).getTime(),
      ccv: Number(row.ccv),
      chatters: row.chatters != null ? Number(row.chatters) : null,
    });
  }
  return map;
}

// ── Per-session scoring (pure JS over prefetched data) ─────────────────

function scoreOne(
  candidate: Candidate,
  stats: TargetStats,
  /** Engagement/followers baseline — platform-preferred, possibly a
   *  borrowed lower band (its band name says which), always excluding
   *  the target channel's own sessions. */
  eng: { view: CohortView | null; platform: string; band: SizeBand },
  /** Curve/spike baseline — always the mixed chain; shape is not
   *  platform-cultural and must not be diluted by a tiny slice. */
  shape: { medianCv: number | null; p99Rise: number | null; band: SizeBand },
  minutes: MinutePoint[],
): { score: number; evidence: HealthEvidence } {
  const flags: HealthFlag[] = [];
  const engView = eng.view; // selection chain already enforced usability
  const tracker = candidate.tracker_slug;
  const engCohortName =
    `${eng.platform === 'all' ? '' : `${eng.platform} `}${eng.band}-CCV ${tracker}`;

  // ── Engagement (40): percentile of mean(chatters/ccv) vs cohort ──────
  let engagementPct: number | null = null;
  let engagementPts: number;
  if (engView) {
    engagementPct = percentile(engView.engs, stats.engRatio);
    engagementPts = Math.round((engagementPct / 100) * ENGAGEMENT_MAX);
    if (engagementPct <= 10) {
      const per1k = Math.round(stats.engRatio * 1000);
      const cohortMedian = median(engView.engs);
      const medianPer1k = Math.round(cohortMedian * 1000);
      const critical =
        engagementPct <= EXTREME_ENG_PCT && stats.engRatio < EXTREME_ENG_RATIO * cohortMedian;
      flags.push({
        kind: 'low_engagement',
        ...(critical ? { severity: 'critical' as const } : {}),
        detail:
          `Roughly ${per1k} unique chatters per 1,000 viewers each minute — ` +
          `bottom ${Math.max(engagementPct, 1)}% of ${engCohortName} streams from the ` +
          `last 30 days (typical is ~${medianPer1k}).` +
          (critical
            ? ' Chat this quiet for the audience size is the strongest single signal we track.'
            : ''),
      });
    }
  } else {
    engagementPts = Math.round(ENGAGEMENT_MAX / 2); // cohort too small to rank against
  }

  // ── Curve organicness (30): deductions from a clean 30 ───────────────
  let curvePts = CURVE_MAX;

  // (a) unnaturally flat: CV far below what organic curves in this cohort do.
  if (
    stats.cv != null &&
    shape.medianCv != null &&
    shape.medianCv > 0 &&
    stats.cv < FLAT_CV_RATIO * shape.medianCv
  ) {
    curvePts -= 15;
    flags.push({
      kind: 'flat_curve',
      detail:
        `Viewer count is unnaturally flat: minute-to-minute variation ` +
        `±${(stats.cv * 100).toFixed(1)}% while organic ${shape.band}-CCV ${tracker} streams ` +
        `vary ±${(shape.medianCv * 100).toFixed(1)}%.`,
    });
  }

  // (b) step discontinuities: |Δccv| > 35% of level within ≤2 min, away
  // from session edges. One -10 regardless of how many steps.
  const startMs = new Date(candidate.started_at).getTime();
  const endMs = new Date(candidate.ended_at).getTime();
  const edgeLo = startMs + EDGE_START_MINUTES * 60_000;
  const edgeHi = endMs - EDGE_END_MINUTES * 60_000;
  const steps: Array<{ from: number; to: number; t: number; gapMin: number }> = [];
  for (let i = 1; i < minutes.length; i++) {
    const prev = minutes[i - 1] as MinutePoint;
    const cur = minutes[i] as MinutePoint;
    const gapMin = (cur.t - prev.t) / 60_000;
    if (gapMin > STEP_MAX_GAP_MIN) continue;
    if (cur.t <= edgeLo || cur.t >= edgeHi) continue;
    if (prev.ccv < RISE_LEVEL_FLOOR) continue;
    if (Math.abs(cur.ccv - prev.ccv) > STEP_DELTA_RATIO * prev.ccv) {
      steps.push({ from: prev.ccv, to: cur.ccv, t: cur.t, gapMin });
    }
  }
  if (steps.length > 0) {
    curvePts -= 10;
    const worst = steps.reduce((a, b) =>
      Math.abs(b.to - b.from) / b.from > Math.abs(a.to - a.from) / a.from ? b : a,
    );
    const pct = Math.round(((worst.to - worst.from) / worst.from) * 100);
    flags.push({
      kind: 'step_discontinuity',
      detail:
        `${steps.length} abrupt viewer step${steps.length === 1 ? '' : 's'} mid-stream — ` +
        `largest ${fmtInt(worst.from)} → ${fmtInt(worst.to)} (${pct >= 0 ? '+' : ''}${pct}%) ` +
        `within ${Math.max(1, Math.round(worst.gapMin))} min at ${fmtUtcTime(worst.t)} UTC. ` +
        `Organic audiences rarely move in synchronized blocks.`,
    });
  }

  // (c) spikes: rises above the cohort's p99 minute-rise. A title change
  // within ±3 min is treated as the cause (raids/hosts we cannot see are
  // exactly why this deducts only 5).
  const spikeThreshold =
    shape.p99Rise != null && shape.p99Rise > 0 ? shape.p99Rise : FALLBACK_SPIKE_RISE;
  const spikes: Array<{ from: number; to: number; t: number; rise: number }> = [];
  for (let i = 1; i < minutes.length; i++) {
    const prev = minutes[i - 1] as MinutePoint;
    const cur = minutes[i] as MinutePoint;
    if (cur.t <= edgeLo || cur.t >= edgeHi) continue; // arrival ramp / wind-down
    if (prev.ccv < RISE_LEVEL_FLOOR || cur.ccv <= prev.ccv) continue;
    const rise = (cur.ccv - prev.ccv) / prev.ccv;
    if (rise > spikeThreshold) spikes.push({ from: prev.ccv, to: cur.ccv, t: cur.t, rise });
  }
  // titles[0] is the opening title; later entries are actual changes.
  const titleChangeTimes = candidate.titles
    .slice(1)
    .map((tc) => new Date(tc.at).getTime())
    .filter((t) => !Number.isNaN(t));
  const unexplained = spikes.filter(
    (s) => !titleChangeTimes.some((t) => Math.abs(t - s.t) <= SPIKE_TITLE_WINDOW_MS),
  );
  if (unexplained.length > 0) {
    curvePts -= 5;
    const worst = unexplained.reduce((a, b) => (b.rise > a.rise ? b : a));
    flags.push({
      kind: 'unexplained_spike',
      detail:
        `Viewer spike ${fmtInt(worst.from)} → ${fmtInt(worst.to)} ` +
        `(+${Math.round(worst.rise * 100)}%) at ${fmtUtcTime(worst.t)} UTC with no title ` +
        `change within ±3 minutes — above the 99th-percentile minute-rise for this cohort.`,
    });
  }
  curvePts = Math.max(0, curvePts);

  // ── Follower conversion (15) ──────────────────────────────────────────
  let followerPts: number;
  if (stats.convPer1k == null || engView == null || engView.convs.length < MIN_COHORT_N) {
    followerPts = 10; // no follower data (or nothing to rank against) → neutral
  } else {
    const pct = percentile(engView.convs, stats.convPer1k);
    followerPts = Math.round((pct / 100) * FOLLOWERS_MAX);
    if (pct <= 10) {
      const delta = (candidate.followers_end as number) - (candidate.followers_start as number);
      flags.push({
        kind: 'low_follower_conversion',
        detail:
          `${delta >= 0 ? '+' : ''}${fmtInt(delta)} follower${Math.abs(delta) === 1 ? '' : 's'} across ` +
          `${fmtInt(candidate.ccv_minutes)} viewer-minutes — bottom ${Math.max(pct, 1)}% of ` +
          `comparable streams. Real audiences of this size usually follow.`,
      });
    }
  }

  // ── Spike response (15): does chat move when viewers move? ───────────
  let responsePts: number;
  if (spikes.length === 0) {
    responsePts = 10; // nothing to respond to → neutral
  } else {
    const corr = spikeResponseCorr(minutes);
    if (corr == null) {
      responsePts = 8; // undefined correlation (flat series) ≈ corr 0
    } else if (corr >= 0.2) {
      responsePts = RESPONSE_MAX;
    } else if (corr >= CORR_NOISE_FLOOR) {
      responsePts = 8; // near-zero either side is noise, not opposition
    } else {
      responsePts = 0;
      flags.push({
        kind: 'chat_unresponsive',
        detail:
          `Chat did not follow the audience: viewer changes and chatter changes moved ` +
          `oppositely (correlation ${corr.toFixed(2)}) despite ${spikes.length} viewer ` +
          `spike${spikes.length === 1 ? '' : 's'}.`,
      });
    }
  }

  const score = clamp(engagementPts + curvePts + followerPts + responsePts, 0, 100);
  const evidence: HealthEvidence = {
    engagementPct,
    cohort: { tracker, band: eng.band, n: engView?.n ?? 0, platform: eng.platform },
    flags,
    subscores: {
      engagement: engagementPts,
      curve: curvePts,
      followers: followerPts,
      spikeResponse: responsePts,
    },
  };
  return { score, evidence };
}

/**
 * Pearson correlation of Δccv vs Δchatters over consecutive covered
 * minutes (both metrics present, ≤2 min apart). Null when there are too
 * few pairs or either series has zero variance.
 */
function spikeResponseCorr(minutes: MinutePoint[]): number | null {
  const dCcv: number[] = [];
  const dChat: number[] = [];
  for (let i = 1; i < minutes.length; i++) {
    const prev = minutes[i - 1] as MinutePoint;
    const cur = minutes[i] as MinutePoint;
    if (prev.chatters == null || cur.chatters == null) continue;
    if ((cur.t - prev.t) / 60_000 > STEP_MAX_GAP_MIN) continue;
    dCcv.push(cur.ccv - prev.ccv);
    dChat.push(cur.chatters - prev.chatters);
  }
  return pearson(dCcv, dChat);
}

// ── Small numeric helpers ──────────────────────────────────────────────

/** Midpoint-tie percentile (0-100) of x within values. */
function percentile(values: number[], x: number): number {
  if (values.length === 0) return 50;
  let less = 0;
  let equal = 0;
  for (const v of values) {
    if (v < x) less++;
    else if (v === x) equal++;
  }
  return Math.round((100 * (less + equal / 2)) / values.length);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i] as number;
    sy += ys[i] as number;
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtUtcTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Retry transient Postgres deadlocks (40P01) against the live close pass. */
async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '40P01' || i >= attempts) throw err;
      const wait = 1000 * i + Math.floor(Math.random() * 500);
      logger.warn(`[StreamHealth] deadlock on write-back — retrying in ${wait}ms (${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
