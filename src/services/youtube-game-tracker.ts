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
import { watchlistVideoIds } from './youtube-channel-watch';

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
  /**
   * STRONG signals — high confidence this is the tracked game:
   *   strongTags     exact match against the creator's own tags ("pubg")
   *   strongPhrases  distinctive title phrase ("pubg: battlegrounds")
   * A strong match is auto-allowed (below the always-review ceiling).
   */
  strongTags?: string[];
  strongPhrases?: string[];
  /** WEAK signals — matched against title, tags AND description. */
  include?: string[];
  /** Auto-deny when found in the TITLE; downgrades to review when in tags. */
  exclude?: string[];
  /**
   * Scalability dials. Reviewing every channel doesn't scale, but the
   * damage from a wrong include scales with audience size — so only
   * channels that are BOTH uncertain AND material need a human.
   */
  /** Weak matches below this CCV are auto-allowed (0 = always review). */
  autoAllowWeakBelowCcv?: number;
  /** Above this CCV a human always confirms, however strong the match. */
  alwaysReviewAboveCcv?: number;
  /** Cap on ids polled per cycle. */
  maxRoster?: number;
  /** Seconds between Live-search scrapes (default 600, floor 120). */
  discoveryIntervalSeconds?: number;
}

const DEFAULT_AUTO_ALLOW_WEAK_BELOW_CCV = 200;
const DEFAULT_ALWAYS_REVIEW_ABOVE_CCV = 1_000;

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
 * Decide whether one live video belongs to this tracker.
 *
 * Two problems shaped this. First, a title alone is a poor signal — an
 * esports watch party may be titled "PNC 2026 Day 3" and never say the
 * game — so tags (creator-declared) and the description are matched too.
 * Second, asking a human to approve every channel before anything is
 * tracked does not scale past one game.
 *
 * The resolution: weight review effort by IMPACT. A wrongly-included
 * 20-viewer channel changes nothing; a wrongly-included 10k channel ruins
 * the tracker. So confident matches are tracked immediately, small
 * uncertain ones are tracked provisionally, and a human is asked only
 * about streams that are BOTH uncertain AND large enough to matter —
 * plus every large stream, however confident, as a backstop.
 */
export function gateVideo(
  video: YouTubeLiveVideo,
  cfg: YouTubeTrackerConfig,
  existing: GatingModel.StoredDecision | undefined,
): GateOutcome {
  const reviewFloorEarly = cfg.alwaysReviewAboveCcv ?? DEFAULT_ALWAYS_REVIEW_ABOVE_CCV;

  // A HUMAN decision is final — that's the point of recording it.
  if (existing?.human) {
    return existing.decision === 'allow'
      ? { decision: 'allow', reason: 'channel allowed by review' }
      : { decision: 'deny', reason: 'channel denied by review' };
  }
  // An AUTOMATIC decision is provisional. A channel auto-allowed at 300
  // viewers must not stay allowed unexamined at 3,000 — the stakes changed,
  // so it goes back for review. (This is how MortaL, auto-allowed small on
  // a stale "pubg" tag, ended up topping the board while playing Party
  // Animals.) Denials stay: re-testing them every cycle just churns.
  if (existing?.decision === 'deny') return { decision: 'deny', reason: 'channel denied' };
  if (existing?.decision === 'allow' && video.concurrentViewers < reviewFloorEarly) {
    return { decision: 'allow', reason: 'channel auto-allowed' };
  }

  const title = (video.title ?? '').toLowerCase();
  const description = (video.description ?? '').toLowerCase();
  const tags = (video.tags ?? []).map((t) => t.toLowerCase());
  const ccv = video.concurrentViewers;

  const lower = (xs?: string[]) => (xs ?? []).map((s) => s.toLowerCase()).filter(Boolean);
  const exclude = lower(cfg.exclude);
  const include = lower(cfg.include);
  const strongTags = lower(cfg.strongTags);
  const strongPhrases = lower(cfg.strongPhrases);

  const weakCeiling = cfg.autoAllowWeakBelowCcv ?? DEFAULT_AUTO_ALLOW_WEAK_BELOW_CCV;
  const reviewFloor = cfg.alwaysReviewAboveCcv ?? DEFAULT_ALWAYS_REVIEW_ABOVE_CCV;

  // ── Negative signals ────────────────────────────────────────────────
  // The title says what they're streaming RIGHT NOW — trust it to deny.
  const titleExclude = exclude.find((kw) => title.includes(kw));
  if (titleExclude) return { decision: 'deny', reason: `title excluded by "${titleExclude}"` };

  if (video.categoryId != null && video.categoryId !== GAMING_CATEGORY_ID) {
    return { decision: 'deny', reason: `category ${video.categoryId} is not Gaming` };
  }

  // Tags are aspirational (streamers tag every game they play), so an
  // excluded tag only casts doubt — it doesn't convict.
  const tagExclude = exclude.find((kw) => tags.some((t) => t.includes(kw)));

  // ── Positive signals, strongest first ───────────────────────────────
  //
  // The TITLE is evidence about this stream; tags and description are
  // evidence about the CHANNEL. MortaL tags every broadcast with "pubg",
  // "bgmi" and "pubg mobile" whatever he's actually playing — so a tag
  // match is only trustworthy when the channel's own tags aren't also
  // advertising a game we exclude. When they contradict each other, the
  // title is the only witness that knows what's on screen right now.
  const phraseHit = strongPhrases.find((p) => title.includes(p));
  const tagHit = tagExclude ? undefined : strongTags.find((t) => tags.includes(t));
  const strong = phraseHit ?? tagHit ?? null;

  const weakIn = include.find((kw) => title.includes(kw));
  const weakTag = include.find((kw) => tags.some((t) => t.includes(kw)));
  const weakDesc = include.find((kw) => description.includes(kw));
  const weak = weakIn ?? weakTag ?? weakDesc ?? null;

  if (!strong && !weak) {
    return {
      decision: 'deny',
      reason: include.length > 0 ? 'no game keyword in title, tags or description' : 'no match',
    };
  }

  const where = strong
    ? phraseHit
      ? `title phrase "${phraseHit}"`
      : `tag "${tagHit}"`
    : weakIn
      ? `title "${weakIn}"`
      : weakTag
        ? `tag "${weakTag}"`
        : `description "${weakDesc}"`;

  // Anything big gets a human look regardless of confidence — this is the
  // backstop that keeps a 10k mis-match out of the numbers.
  if (ccv >= reviewFloor) {
    return {
      decision: 'pending',
      reason: `${strong ? 'strong' : 'weak'} match on ${where}, but ${ccv} viewers — confirm before counting`,
    };
  }

  if (strong) return { decision: 'allow', reason: `strong match on ${where}` };

  if (tagExclude) {
    return {
      decision: weakIn ? 'pending' : 'deny',
      reason: weakIn
        ? `title mentions "${weakIn}" but channel also tagged "${tagExclude}"`
        : `only channel-level match (${where}); channel tagged "${tagExclude}" — not this game`,
    };
  }

  if (ccv < weakCeiling) {
    return { decision: 'allow', reason: `weak match on ${where} (${ccv} viewers — auto)` };
  }

  return { decision: 'pending', reason: `weak match on ${where} — awaiting review` };
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

    // Channels a human already approved are watched directly via their RSS
    // feed, so they keep being tracked on days their title matches nothing
    // (e.g. an esports watch party titled "PNC Day 3").
    const decisions = await GatingModel.decisionMap(tracker.id);
    const allowedChannelIds = [...decisions.entries()]
      .filter(([, d]) => d.decision === 'allow')
      .map(([channelId]) => channelId);
    if (allowedChannelIds.length > 0) {
      try {
        for (const id of await watchlistVideoIds(allowedChannelIds)) roster.add(id);
      } catch (err) {
        logger.debug(`[YT:${tracker.slug}] watchlist failed: ${(err as Error).message}`);
      }
    }

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
