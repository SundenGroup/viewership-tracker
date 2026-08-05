import { Router, Request, Response, NextFunction } from 'express';
import db from '../../utils/db';
import * as GameTrackerModel from '../../models/game-tracker';
import * as GameTrackerChannelModel from '../../models/game-tracker-channel';
import * as GameTrackerSnapshotModel from '../../models/game-tracker-snapshot';
import * as StreamSessionModel from '../../models/stream-session';
import * as ChannelModel from '../../models/channel';
import * as GatingModel from '../../models/game-tracker-youtube-channel';
import * as QuarantineModel from '../../models/game-tracker-youtube-quarantine';
import { promoteHeldSnapshots } from '../../services/youtube-quarantine-promote';
import { requireRole } from '../middleware/auth';
import type { GameTrackerService } from '../../services/game-tracker-service';
import logger from '../../utils/logger';

const router = Router();

// The orchestrating service is injected from src/index.ts at startup.
let trackerService: GameTrackerService | null = null;
export function setGameTrackerService(svc: GameTrackerService): void {
  trackerService = svc;
}

// ── Public list / detail (any authenticated user) ────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trackers = await GameTrackerModel.findAll();
    res.json(trackers);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const activeCount = await GameTrackerChannelModel.countActive(tracker.id);
    const lastResult = trackerService?.getLastResult(tracker.id) ?? null;
    res.json({ ...tracker, active_channel_count: activeCount, last_cycle: lastResult });
  } catch (err) {
    next(err);
  }
});

// ── Admin CRUD ─────────────────────────────────────────────────────────

const RESERVED_SLUGS = new Set(['admin', 'new']);

router.post('/', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (RESERVED_SLUGS.has(String((req.body ?? {}).slug ?? '').toLowerCase())) {
      res.status(400).json({ error: 'That slug is reserved' });
      return;
    }
    const { name, slug } = req.body;
    if (!name || !slug || typeof name !== 'string' || typeof slug !== 'string') {
      res.status(400).json({ error: 'name and slug are required' });
      return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'slug must be lowercase alphanumeric + hyphens only' });
      return;
    }
    if (
      !req.body.twitch_game_id && !req.body.kick_category_id &&
      !req.body.soop_category_id && !req.body.tiktok_category_slug
    ) {
      res.status(400).json({ error: 'at least one platform category (Twitch, Kick, SOOP or TikTok) is required' });
      return;
    }
    const tracker = await GameTrackerModel.create(req.body);
    if (tracker.status === 'active') {
      trackerService?.startTracker(tracker.id).catch((err: Error) =>
        logger.warn(`[GameTracker] failed to start tracker ${tracker.id} after create`, {
          error: err.message,
        }),
      );
    }
    res.status(201).json(tracker);
  } catch (err) {
    next(err);
  }
});

router.put('/:slug', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!existing) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const updated = await GameTrackerModel.update(existing.id, req.body);

    // Sync the running service with the new status.
    if (trackerService) {
      if (updated.status === 'active') {
        trackerService.startTracker(updated.id).catch(() => {});
      } else {
        trackerService.stopTracker(updated.id);
      }
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:slug', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!existing) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    trackerService?.stopTracker(existing.id);
    await GameTrackerModel.remove(existing.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ── Official event windows (chart overlays) ───────────────────────────
//
// "Was that spike PGS?" — Discover's trends chart shades the broadcast
// windows of series for the same game. The tracker↔series link is the
// game name, compared with everything but letters/digits stripped, since
// the same title is written "PUBG: Battlegrounds", "PUBG Battlegrounds"
// and "PUBG BATTLEGROUNDS" across series records.
router.get('/:slug/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const from = new Date(String(req.query.from ?? ''));
    const to = new Date(String(req.query.to ?? ''));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      res.status(400).json({ error: 'from and to must be valid dates with to > from' });
      return;
    }
    const { rows } = await db.raw<{
      rows: Array<{ name: string; short_name: string | null; start: Date; end: Date }>;
    }>(
      `
      SELECT s.name, s.short_name, d.broadcast_start AS start, d.broadcast_end AS "end"
      FROM tournament_series s
      JOIN broadcast_days d ON d.series_id = s.id
      WHERE regexp_replace(LOWER(COALESCE(s.game, '')), '[^a-z0-9]', '', 'g')
              = regexp_replace(LOWER(?), '[^a-z0-9]', '', 'g')
        AND d.broadcast_start IS NOT NULL
        AND d.broadcast_end IS NOT NULL
        AND d.broadcast_end > ?
        AND d.broadcast_start < ?
      ORDER BY d.broadcast_start
      LIMIT 200
      `,
      [tracker.name, from, to],
    );
    res.json({
      events: rows.map((r) => ({
        name: r.short_name || r.name,
        start: r.start,
        end: r.end,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── YouTube gating (Discover) ──────────────────────────────────────────
//
// YouTube exposes no reliable game association, so tracker membership is a
// human decision recorded per channel. These endpoints drive the review
// queue: list what the poller has seen, then allow/deny it for good.

router.get(
  '/:slug/youtube/gating',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
      if (!tracker) {
        res.status(404).json({ error: 'Game tracker not found' });
        return;
      }
      const decision = req.query.decision as GatingModel.GatingDecision | undefined;
      if (decision && !['allow', 'deny', 'pending'].includes(decision)) {
        res.status(400).json({ error: 'decision must be allow, deny or pending' });
        return;
      }
      const [rows, counts, held] = await Promise.all([
        GatingModel.list(tracker.id, decision),
        GatingModel.counts(tracker.id),
        QuarantineModel.statsByChannel(tracker.id),
      ]);
      res.json({
        enabled: tracker.youtube_enabled,
        config: tracker.youtube_config ?? {},
        counts,
        // held_minutes/held_from tell the reviewer data is banked while
        // they decide — approving late recovers it, so no need to rush.
        rows: rows.map((r) => {
          const h = held.get(r.channel_identifier);
          return h
            ? { ...r, held_minutes: h.held_minutes, held_from: h.held_from }
            : r;
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Edit a tracker's YouTube matching vocabulary.
 *
 * These lists ARE the gating rules — `include`/`strongPhrases`/`strongTags`
 * decide which streams from an approved channel count, so they need to be
 * editable by the person working the review queue, not by whoever can
 * reach the database. Merged into the existing config so a partial save
 * never silently drops a key the UI doesn't render.
 */
const STRING_LIST_KEYS = [
  'queries', 'include', 'exclude', 'strongTags', 'strongPhrases',
] as const;
const NUMERIC_KEYS: Record<string, { min: number; max: number }> = {
  autoAllowWeakBelowCcv: { min: 0, max: 1_000_000 },
  alwaysReviewAboveCcv: { min: 0, max: 1_000_000 },
  discoveryPagesPerQuery: { min: 1, max: 10 },
  maxRoster: { min: 1, max: 2_000 },
  discoveryIntervalSeconds: { min: 120, max: 86_400 },
};

router.put(
  '/:slug/youtube/config',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
      if (!tracker) {
        res.status(404).json({ error: 'Game tracker not found' });
        return;
      }
      const body = (req.body ?? {}) as { enabled?: unknown; config?: Record<string, unknown> };
      const incoming = body.config ?? {};
      const merged: Record<string, unknown> = { ...(tracker.youtube_config ?? {}) };

      for (const key of STRING_LIST_KEYS) {
        if (incoming[key] === undefined) continue;
        const val = incoming[key];
        if (!Array.isArray(val) || val.some((v) => typeof v !== 'string')) {
          res.status(400).json({ error: `${key} must be an array of strings` });
          return;
        }
        // Trim, drop blanks, de-dupe — the UI sends a comma-separated field.
        merged[key] = [...new Set((val as string[]).map((v) => v.trim()).filter(Boolean))];
      }

      for (const [key, bounds] of Object.entries(NUMERIC_KEYS)) {
        if (incoming[key] === undefined) continue;
        const n = Number(incoming[key]);
        if (!Number.isFinite(n) || n < bounds.min || n > bounds.max) {
          res.status(400).json({ error: `${key} must be between ${bounds.min} and ${bounds.max}` });
          return;
        }
        merged[key] = Math.round(n);
      }

      const patch: Record<string, unknown> = { youtube_config: merged };
      if (typeof body.enabled === 'boolean') patch.youtube_enabled = body.enabled;

      const updated = await GameTrackerModel.update(tracker.id, patch);
      res.json({ enabled: updated.youtube_enabled, config: updated.youtube_config ?? {} });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:slug/youtube/gating/:channelIdentifier',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
      if (!tracker) {
        res.status(404).json({ error: 'Game tracker not found' });
        return;
      }
      const { decision, note, scope } = (req.body ?? {}) as {
        decision?: string;
        note?: string;
        scope?: string;
      };
      const channelIdentifier = req.params.channelIdentifier as string;
      const user = (req as Request & { user?: { username?: string } }).user;

      if (decision === 'reset') {
        await GatingModel.reset(tracker.id, channelIdentifier);
        res.json({ ok: true, decision: 'pending' });
        return;
      }
      if (decision !== 'allow' && decision !== 'deny') {
        res.status(400).json({ error: "decision must be 'allow', 'deny' or 'reset'" });
        return;
      }
      if (scope && scope !== 'matching' && scope !== 'all') {
        res.status(400).json({ error: "scope must be 'matching' or 'all'" });
        return;
      }
      const effectiveScope = (scope as GatingModel.GatingScope | undefined) ?? 'matching';
      const row = await GatingModel.decide(
        tracker.id,
        channelIdentifier,
        decision,
        user?.username ?? 'unknown',
        note,
        effectiveScope,
      );
      if (!row) {
        res.status(404).json({ error: 'Channel not found in this tracker’s queue' });
        return;
      }
      logger.info(
        `[YTGating] ${user?.username ?? 'unknown'} set ${channelIdentifier} → ${decision} on ${tracker.slug}`,
      );

      // Settle the quarantine: approval promotes the held viewership into
      // real snapshots (with original timestamps), denial discards it.
      // The decision above is already recorded — a failure here must not
      // undo it, so report it instead of throwing.
      if (decision === 'allow') {
        try {
          const promoted = await promoteHeldSnapshots(tracker, channelIdentifier, effectiveScope);
          res.json({ ...row, promoted });
          return;
        } catch (err) {
          logger.error(`[YTGating] promotion failed for ${channelIdentifier} on ${tracker.slug}`, {
            error: (err as Error).message,
          });
          res.json({ ...row, promotion_error: 'held data could not be promoted — see server logs' });
          return;
        }
      }
      const discarded = await QuarantineModel.discardChannel(tracker.id, channelIdentifier)
        .catch((err) => {
          logger.warn(`[YTGating] quarantine discard failed for ${channelIdentifier}`, {
            error: (err as Error).message,
          });
          return 0;
        });
      res.json({ ...row, discarded_snapshots: discarded });
    } catch (err) {
      next(err);
    }
  },
);

// ── Channels for a tracker ─────────────────────────────────────────────

router.get('/:slug/channels', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const assignments = await GameTrackerChannelModel.listActive(tracker.id);
    if (assignments.length === 0) {
      res.json([]);
      return;
    }
    const channelIds = assignments.map((a) => a.channel_id);
    const channels = await ChannelModel.findByIds(channelIds);
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    const merged = assignments.map((a) => ({
      ...a,
      channel: channelMap.get(a.channel_id) ?? null,
    }));
    res.json(merged);
  } catch (err) {
    next(err);
  }
});

router.delete(
  '/:slug/channels/:channelId',
  requireRole('admin', 'editor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
      if (!tracker) {
        res.status(404).json({ error: 'Game tracker not found' });
        return;
      }
      const assignment = await GameTrackerChannelModel.findByTrackerAndChannel(
        tracker.id,
        req.params.channelId as string,
      );
      if (!assignment) {
        res.status(404).json({ error: 'Channel not assigned to this tracker' });
        return;
      }
      await GameTrackerChannelModel.softDrop(assignment.id, 'manual');
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ── Trends + leaderboard ───────────────────────────────────────────────

router.get('/:slug/snapshots/range', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const fromTs = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 60 * 60_000);
    const toTs = req.query.to ? new Date(String(req.query.to)) : new Date();
    const bucketSeconds = req.query.bucketSeconds ? Number(req.query.bucketSeconds) : 60;

    if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime())) {
      res.status(400).json({ error: 'from / to must be valid ISO timestamps' });
      return;
    }
    if (toTs.getTime() <= fromTs.getTime()) {
      res.status(400).json({ error: 'to must be after from' });
      return;
    }

    const platform = req.query.platform ? String(req.query.platform) : null;
    const buckets = await GameTrackerSnapshotModel.rangeAggregate(
      tracker.id, fromTs, toTs, bucketSeconds, platform,
    );
    res.json({ from: fromTs, to: toTs, bucket_seconds: bucketSeconds, buckets });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/leaderboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 200) : 50;
    if (Number.isNaN(at.getTime())) {
      res.status(400).json({ error: 'at must be a valid ISO timestamp' });
      return;
    }
    const rows = await GameTrackerSnapshotModel.leaderboardAt(tracker.id, at, 120, limit);
    if (rows.length === 0) {
      res.json([]);
      return;
    }
    const channelIds = rows.map((r) => r.channel_id);
    const [channels, grades, liveStarts] = await Promise.all([
      ChannelModel.findByIds(channelIds),
      StreamSessionModel.lastGradesFor(tracker.id, channelIds),
      StreamSessionModel.liveStartsFor(tracker.id, channelIds),
    ]);
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    const merged = rows.map((r) => ({
      ...r,
      channel: channelMap.get(r.channel_id) ?? null,
      // Grade of the channel's last COMPLETED broadcast — never the live one.
      last_grade: grades.get(r.channel_id)?.grade ?? null,
      last_score: grades.get(r.channel_id)?.score ?? null,
      live_started_at: liveStarts.get(r.channel_id) ?? null,
    }));
    res.json(merged);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/breakdown', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const fromTs = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 60 * 60_000);
    const toTs = req.query.to ? new Date(String(req.query.to)) : new Date();
    const platformFilter = req.query.platform ? String(req.query.platform) : null;
    const [platform, language] = await Promise.all([
      GameTrackerSnapshotModel.platformBreakdown(tracker.id, fromTs, toTs, platformFilter),
      GameTrackerSnapshotModel.languageBreakdown(tracker.id, fromTs, toTs, platformFilter),
    ]);
    res.json({ from: fromTs, to: toTs, platform, language });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/channels/:channelId/timeline', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const channelId = req.params.channelId as string;
    const channel = await ChannelModel.findById(channelId);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const fromTs = req.query.from
      ? new Date(String(req.query.from))
      : new Date(Date.now() - 24 * 60 * 60_000);
    const toTs = req.query.to ? new Date(String(req.query.to)) : new Date();
    const bucketSeconds = req.query.bucketSeconds ? Number(req.query.bucketSeconds) : 60;
    if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime())) {
      res.status(400).json({ error: 'from / to must be valid ISO timestamps' });
      return;
    }
    const [timeline, sessions] = await Promise.all([
      GameTrackerSnapshotModel.channelTimeline(tracker.id, channelId, fromTs, toTs, bucketSeconds),
      GameTrackerSnapshotModel.channelSessions(tracker.id, channelId, 30),
    ]);
    res.json({
      from: fromTs,
      to: toTs,
      bucket_seconds: bucketSeconds,
      channel,
      timeline,
      sessions,
    });
  } catch (err) {
    next(err);
  }
});

// ── Streamer depth (stored stream sessions + engagement) ──────────────

/**
 * GET /:slug/channels/:channelId/sessions?limit=30&offset=0
 *
 * Stored stream sessions for one channel, newest first. Live sessions
 * are included with their current running peak (minute/chat finals stay
 * 0 until the close pass computes them).
 */
// Evidence gate: a channel must have this many SCORED sessions (30d)
// before any health grade is shown anywhere. One odd stream (subathon
// sleep segment, chat-elsewhere co-stream) must not read as a verdict —
// scores are still computed and stored from session one, they just stay
// silent until a pattern exists. Suppressed server-side so no client can
// render an ungated grade.
const HEALTH_MIN_SESSIONS = Math.max(1, Number(process.env.HEALTH_MIN_SESSIONS ?? 3));

function stripHealth(row: ReturnType<typeof StreamSessionModel.toRow>) {
  return { ...row, health_score: null, health_grade: null, health_evidence: null };
}

router.get('/:slug/channels/:channelId/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const channelId = req.params.channelId as string;
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 200) : 30;
    const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
    const [total, sessions, health] = await Promise.all([
      StreamSessionModel.countByChannel(tracker.id, channelId),
      StreamSessionModel.listByChannel(tracker.id, channelId, limit, offset),
      StreamSessionModel.healthSummary30d(tracker.id, channelId),
    ]);
    const gated = health.scoredSessions < HEALTH_MIN_SESSIONS;
    res.json({
      total,
      rows: sessions.map((s) =>
        gated ? stripHealth(StreamSessionModel.toRow(s)) : StreamSessionModel.toRow(s),
      ),
      healthPending: gated
        ? { scored: health.scoredSessions, required: HEALTH_MIN_SESSIONS }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:slug/channels/:channelId/streams/:streamId
 *
 * Deep-dive for a single stream session: the stored row, its per-minute
 * CCV timeline, chat volume, follower delta, title history, same-day
 * peak rank within the tracker, and prev/next stream navigation.
 */
router.get(
  '/:slug/channels/:channelId/streams/:streamId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
      if (!tracker) {
        res.status(404).json({ error: 'Game tracker not found' });
        return;
      }
      const channelId = req.params.channelId as string;
      const streamId = req.params.streamId as string;
      const session = await StreamSessionModel.findByStream(tracker.id, channelId, streamId);
      if (!session) {
        res.status(404).json({ error: 'Stream session not found' });
        return;
      }
      const windowEnd = session.ended_at ?? new Date();
      const [timeline, chat, rank, neighbors, health] = await Promise.all([
        StreamSessionModel.sessionTimeline(tracker.id, channelId, session.started_at, windowEnd),
        StreamSessionModel.chatWindow(channelId, session.started_at, windowEnd),
        StreamSessionModel.rankForSession(tracker.id, session.id),
        StreamSessionModel.neighborStreamIds(tracker.id, channelId, session.started_at),
        StreamSessionModel.healthSummary30d(tracker.id, channelId),
      ]);
      const gated = health.scoredSessions < HEALTH_MIN_SESSIONS;
      res.json({
        healthPending: gated
          ? { scored: health.scoredSessions, required: HEALTH_MIN_SESSIONS }
          : null,
        session: gated
          ? stripHealth(StreamSessionModel.toRow(session))
          : StreamSessionModel.toRow(session),
        timeline,
        chat,
        followers: {
          start: session.followers_start,
          end: session.followers_end,
          delta:
            session.followers_start != null && session.followers_end != null
              ? session.followers_end - session.followers_start
              : null,
        },
        titleChanges: session.titles,
        rank,
        prevStreamId: neighbors.prevStreamId,
        nextStreamId: neighbors.nextStreamId,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /:slug/channels/:channelId/summary
 *
 * Channel-level engagement summary: follower count + 7d delta, today's
 * peak rank in the tracker, 30d peak percentile, average chat
 * engagement (chatters per viewer) over the last 30 days, and the 30d
 * health rollup (median flag-gated grade of the channel's scored
 * sessions; null when nothing is scored yet).
 */
router.get('/:slug/channels/:channelId/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const channelId = req.params.channelId as string;
    const [followers, rank, peakPercentile30d, avgChattersPerViewerPct, health] = await Promise.all([
      StreamSessionModel.followerSummary(channelId),
      StreamSessionModel.todayRank(tracker.id, channelId),
      StreamSessionModel.peakPercentile30d(tracker.id, channelId),
      StreamSessionModel.avgChattersPerViewerPct(tracker.id, channelId),
      StreamSessionModel.healthSummary30d(tracker.id, channelId),
    ]);
    const gated = health.scoredSessions < HEALTH_MIN_SESSIONS;
    res.json({
      followers,
      rank,
      peakPercentile30d,
      engagement: { avgChattersPerViewerPct },
      healthGrade30d: !gated ? health.medianGrade : null,
      healthAvgScore30d: gated ? null : health.avgScore,
      healthScoredSessions30d: health.scoredSessions,
      healthMinSessions: HEALTH_MIN_SESSIONS,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const q = (req.query.q as string | undefined)?.trim();
    if (!q || q.length < 2) {
      res.status(400).json({ error: 'q must be at least 2 characters' });
      return;
    }
    const days = req.query.days ? Math.min(Math.max(Number(req.query.days), 1), 365) : 30;
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 100) : 50;
    const rows = await GameTrackerSnapshotModel.searchTitlesAndChannels(tracker.id, q, days, limit);
    if (rows.length === 0) {
      res.json({ query: q, days, rows: [] });
      return;
    }
    const channels = await ChannelModel.findByIds(rows.map((r) => r.channel_id));
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    res.json({
      query: q,
      days,
      rows: rows.map((r) => ({ ...r, channel: channelMap.get(r.channel_id) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/range-leaderboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const fromTs = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 60 * 60_000);
    const toTs = req.query.to ? new Date(String(req.query.to)) : new Date();
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 200) : 50;
    const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
    const language = req.query.language ? String(req.query.language) : null;
    const platform = req.query.platform ? String(req.query.platform) : null;
    if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime())) {
      res.status(400).json({ error: 'from / to must be valid ISO timestamps' });
      return;
    }
    if (toTs.getTime() <= fromTs.getTime()) {
      res.status(400).json({ error: 'to must be after from' });
      return;
    }
    const [rows, total] = await Promise.all([
      GameTrackerSnapshotModel.rangeLeaderboard(tracker.id, fromTs, toTs, limit, {
        language,
        platform,
        offset,
      }),
      GameTrackerSnapshotModel.countRangeLeaderboard(tracker.id, fromTs, toTs, { language, platform }),
    ]);
    if (rows.length === 0) {
      res.json({ from: fromTs, to: toTs, total, rows: [] });
      return;
    }
    const channels = await ChannelModel.findByIds(rows.map((r) => r.channel_id));
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    res.json({
      from: fromTs,
      to: toTs,
      total,
      rows: rows.map((r) => ({ ...r, channel: channelMap.get(r.channel_id) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:slug/trending?hours=24&limit=20
 *
 * Risers & anomalies: each channel's peak in the last N hours compared to
 * its peak in the N hours before that. Powers the Discover "Trending"
 * section — biggest gainers, sudden multi-x spikes, and channels that
 * appeared from nothing (prev window empty).
 */
router.get('/:slug/trending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const hours = req.query.hours ? Math.min(Math.max(Number(req.query.hours), 1), 168) : 24;
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 50) : 20;
    const now = Date.now();
    const curFrom = new Date(now - hours * 3_600_000);
    const prevFrom = new Date(now - 2 * hours * 3_600_000);

    const result = await db.raw(
      `
      WITH cur AS (
        SELECT channel_id, max(concurrent_viewers) AS peak
        FROM game_tracker_snapshots
        WHERE game_tracker_id = ? AND timestamp >= ?
        GROUP BY channel_id
      ),
      prev AS (
        SELECT channel_id, max(concurrent_viewers) AS peak
        FROM game_tracker_snapshots
        WHERE game_tracker_id = ? AND timestamp >= ? AND timestamp < ?
        GROUP BY channel_id
      )
      SELECT c.channel_id,
             c.peak            AS cur_peak,
             COALESCE(p.peak, 0) AS prev_peak,
             (p.channel_id IS NULL) AS is_new
      FROM cur c
      LEFT JOIN prev p ON p.channel_id = c.channel_id
      WHERE c.peak >= 50 AND c.peak > COALESCE(p.peak, 0)
      ORDER BY (c.peak - COALESCE(p.peak, 0)) DESC
      LIMIT ?
      `,
      [tracker.id, curFrom, tracker.id, prevFrom, curFrom, limit],
    );
    const rows = (result.rows ?? []) as Array<{
      channel_id: string;
      cur_peak: number;
      prev_peak: number;
      is_new: boolean;
    }>;
    if (rows.length === 0) {
      res.json({ hours, rows: [] });
      return;
    }
    const channels = await ChannelModel.findByIds(rows.map((r) => r.channel_id));
    const channelMap = new Map(channels.map((c) => [c.id, c]));
    res.json({
      hours,
      rows: rows.map((r) => ({ ...r, channel: channelMap.get(r.channel_id) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:slug/recent-channels?hours=48&limit=15
 *
 * Channels the tracker discovered recently (game_tracker_channels.joined_at
 * within the window, not dropped), newest first, with their peak so far.
 * Powers the "recently discovered" strip.
 */
router.get('/:slug/recent-channels', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracker = await GameTrackerModel.findBySlug(req.params.slug as string);
    if (!tracker) {
      res.status(404).json({ error: 'Game tracker not found' });
      return;
    }
    const hours = req.query.hours ? Math.min(Math.max(Number(req.query.hours), 1), 336) : 48;
    const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 50) : 15;
    const since = new Date(Date.now() - hours * 3_600_000);

    const joins = await db('game_tracker_channels as gtc')
      .join('channels as c', 'c.id', 'gtc.channel_id')
      .where('gtc.game_tracker_id', tracker.id)
      .where('gtc.joined_at', '>=', since)
      .whereNull('gtc.dropped_at')
      .orderBy('gtc.joined_at', 'desc')
      .limit(limit)
      .select(
        'gtc.joined_at',
        'c.id as channel_id',
        'c.platform',
        'c.channel_identifier',
        'c.display_name',
        'c.language',
      );
    if (joins.length === 0) {
      res.json({ hours, rows: [] });
      return;
    }
    // Peak since joining, per channel, in one grouped query.
    const peaks = await db('game_tracker_snapshots')
      .where('game_tracker_id', tracker.id)
      .whereIn('channel_id', joins.map((j) => j.channel_id))
      .where('timestamp', '>=', since)
      .groupBy('channel_id')
      .select('channel_id')
      .max('concurrent_viewers as peak');
    const peakMap = new Map(peaks.map((p) => [p.channel_id, Number(p.peak)]));
    res.json({
      hours,
      rows: joins.map((j) => ({ ...j, peak: peakMap.get(j.channel_id) ?? 0 })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
