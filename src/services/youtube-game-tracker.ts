/**
 * YouTube branch of the live game tracker (Discover).
 *
 * Plan: docs/plans/2026-07-28-youtube-in-discover.md
 *
 * Twitch and Kick hand us an authoritative category listing. YouTube does
 * not, so this module reconstructs one in three steps:
 *
 *   1. ROSTER   — video ids to poll this cycle: the streams we saw live
 *                 recently, plus (on a slower beat) fresh candidates
 *                 scraped from YouTube's own Live search.
 *   2. TRACK    — videos.list batched 50-per-call (1 quota unit per call,
 *                 regardless of id count) for authoritative CCV, title,
 *                 language and start time. Ended streams simply stop
 *                 coming back.
 *   3. GATE     — decide which of those belong to this tracker, since
 *                 YouTube's own metadata can't tell PUBG PC from BGMI.
 *                 Channel decisions are sticky and human-owned; keyword
 *                 rules only ever route a channel INTO the review queue.
 *
 * Only 'allow' channels produce snapshots. 'pending' is deliberately not
 * tracked — quietly counting unreviewed channels is how the wrong game
 * ends up in a tracker's numbers.
 */
import type { Knex } from 'knex';
import logger from '../utils/logger';
import type { YouTubeAdapter, YouTubeLiveVideo } from '../adapters/youtube';
import type { DiscoveredStream } from '../adapters/types';
import type { GameTracker } from '../models/game-tracker';
import * as GatingModel from '../models/game-tracker-youtube-channel';
import { discoverLive } from './youtube-live-discovery';

/** Gaming. The only category signal YouTube exposes. */
const GAMING_CATEGORY_ID = '20';
/** How long a stream stays on the roster after we last saw it live. */
const ROSTER_TTL_MS = 20 * 60_000;
/** Hard ceiling on ids polled per cycle (quota guard: 1 unit per 50). */
const DEFAULT_MAX_ROSTER = 400;
/**
 * How often to re-scrape YouTube's Live search. Deliberately decoupled
 * from the tracker's Twitch/Kick discovery cadence: those are official
 * APIs we may call every cycle, this is an unofficial page. The roster
 * changes far slower than the viewer counts do, so 10 minutes is plenty.
 */
const DEFAULT_DISCOVERY_INTERVAL_S = 600;
const MIN_DISCOVERY_INTERVAL_S = 120;

export interface YouTubeTrackerConfig {
  /** Search phrases for discovery, e.g. ["PUBG BATTLEGROUNDS", "PUBG PC"]. */
  queries?: string[];
  /** Title must contain at least one of these (case-insensitive). */
  include?: string[];
  /** Title containing any of these is auto-denied. */
  exclude?: string[];
  /** Cap on ids polled per cycle. */
  maxRoster?: number;
  /** Seconds between Live-search scrapes (default 600, floor 120). */
  discoveryIntervalSeconds?: number;
}

export interface YouTubeCycleResult {
  rosterSize: number;
  liveFound: number;
  allowed: number;
  pending: number;
  denied: number;
  discoveryRan: boolean;
  quotaCalls: number;
}

interface GateOutcome {
  decision: GatingModel.GatingDecision;
  reason: string;
}

/**
 * Apply the tracker's rules to one live video. Keyword rules can DENY
 * outright (clear negative signal) but never auto-ALLOW: an unknown
 * channel that merely looks right goes to review.
 */
export function gateVideo(
  video: YouTubeLiveVideo,
  cfg: YouTubeTrackerConfig,
  existing: GatingModel.GatingDecision | undefined,
): GateOutcome {
  // A recorded decision always wins — that's the point of recording it.
  if (existing === 'allow') return { decision: 'allow', reason: 'channel allowed' };
  if (existing === 'deny') return { decision: 'deny', reason: 'channel denied' };

  const title = (video.title ?? '').toLowerCase();
  const exclude = (cfg.exclude ?? []).map((s) => s.toLowerCase()).filter(Boolean);
  const include = (cfg.include ?? []).map((s) => s.toLowerCase()).filter(Boolean);

  const hitExclude = exclude.find((kw) => title.includes(kw));
  if (hitExclude) return { decision: 'deny', reason: `title excluded by "${hitExclude}"` };

  if (video.categoryId != null && video.categoryId !== GAMING_CATEGORY_ID) {
    return { decision: 'deny', reason: `category ${video.categoryId} is not Gaming` };
  }

  if (include.length > 0) {
    const hit = include.find((kw) => title.includes(kw));
    if (!hit) return { decision: 'deny', reason: 'title matched no include keyword' };
    return { decision: 'pending', reason: `title matched "${hit}" — awaiting review` };
  }

  return { decision: 'pending', reason: 'awaiting review' };
}

export class YouTubeGameTracker {
  private readonly adapter: YouTubeAdapter;
  private readonly db: Knex;
  /** trackerId → last discovery run (discovery is slower than polling). */
  private readonly lastDiscovery = new Map<string, number>();

  constructor(adapter: YouTubeAdapter, db: Knex) {
    this.adapter = adapter;
    this.db = db;
  }

  /**
   * Video ids seen live for this tracker within ROSTER_TTL_MS. Derived from
   * the snapshots we already write, so no extra roster table to keep in
   * sync — a stream that ends ages out on its own.
   */
  private async recentRoster(trackerId: string): Promise<string[]> {
    const rows = await this.db('game_tracker_snapshots')
      .where('game_tracker_id', trackerId)
      .where('platform', 'youtube')
      .where('timestamp', '>=', new Date(Date.now() - ROSTER_TTL_MS))
      .whereNotNull('stream_id')
      .distinct('stream_id')
      .pluck('stream_id');
    return rows as string[];
  }

  /**
   * One YouTube pass for a tracker. Returns streams in the same shape the
   * Twitch/Kick adapters emit, so the caller's reconcile logic is untouched.
   */
  async collect(tracker: GameTracker): Promise<{ streams: DiscoveredStream[]; result: YouTubeCycleResult }> {
    const cfg = (tracker.youtube_config ?? {}) as YouTubeTrackerConfig;
    const result: YouTubeCycleResult = {
      rosterSize: 0, liveFound: 0, allowed: 0, pending: 0, denied: 0,
      discoveryRan: false, quotaCalls: 0,
    };

    // ── 1. Roster ──────────────────────────────────────────────────────
    const roster = new Set(await this.recentRoster(tracker.id));

    const discoveryEverySeconds = Math.max(
      MIN_DISCOVERY_INTERVAL_S,
      cfg.discoveryIntervalSeconds ?? DEFAULT_DISCOVERY_INTERVAL_S,
    );
    const discoveryDue =
      Date.now() - (this.lastDiscovery.get(tracker.id) ?? 0) >= discoveryEverySeconds * 1000;
    if (discoveryDue && (cfg.queries?.length ?? 0) > 0) {
      this.lastDiscovery.set(tracker.id, Date.now());
      result.discoveryRan = true;
      const candidates = await discoverLive(cfg.queries!);
      for (const c of candidates) roster.add(c.videoId);
      logger.debug(
        `[YT:${tracker.slug}] discovery found ${candidates.length}, roster now ${roster.size}`,
      );
    }

    const maxRoster = cfg.maxRoster ?? DEFAULT_MAX_ROSTER;
    const ids = [...roster].slice(0, maxRoster);
    result.rosterSize = ids.length;
    if (ids.length === 0) return { streams: [], result };
    result.quotaCalls = Math.ceil(ids.length / 50);

    // ── 2. Track ───────────────────────────────────────────────────────
    const live = await this.adapter.getLiveVideos(ids);
    result.liveFound = live.length;

    // ── 3. Gate ────────────────────────────────────────────────────────
    const decisions = await GatingModel.decisionMap(tracker.id);
    const streams: DiscoveredStream[] = [];
    const observations: Parameters<typeof GatingModel.observe>[0] = [];

    for (const v of live) {
      const { decision, reason } = gateVideo(v, cfg, decisions.get(v.channelId));
      if (decision === 'allow') result.allowed++;
      else if (decision === 'pending') result.pending++;
      else result.denied++;

      // Record every candidate we actually saw live — the review queue is
      // only useful if it carries current evidence.
      observations.push({
        gameTrackerId: tracker.id,
        channelIdentifier: v.channelId,
        displayName: v.channelTitle || null,
        decision,
        reason,
        sampleTitle: v.title || null,
        sampleVideoId: v.videoId,
        sampleCcv: v.concurrentViewers,
      });

      if (decision !== 'allow') continue;
      streams.push({
        channelIdentifier: v.channelId,
        displayName: v.channelTitle || v.channelId,
        concurrentViewers: v.concurrentViewers,
        language: v.language,
        title: v.title,
        gameName: tracker.name,
        startedAt: v.startedAt,
        streamId: v.videoId,
      });
    }

    try {
      await GatingModel.observe(observations);
    } catch (err) {
      // Never let bookkeeping break a poll cycle.
      logger.warn(`[YT:${tracker.slug}] gating upsert failed`, { error: (err as Error).message });
    }

    return { streams, result };
  }
}
