/**
 * YouTube live-stream discovery for the game tracker (Discover).
 *
 * Plan: docs/plans/2026-07-28-youtube-in-discover.md
 *
 * YouTube has no "list live streams in category X" API worth using:
 * search.list bills 100 units against its own (small) bucket, and returns
 * the same keyword-matched set the website does. So the roster comes from
 * the page the website itself renders — /results with the Live filter —
 * parsed out of `ytInitialData`. Zero quota, no key.
 *
 * This layer is deliberately dumb: it returns CANDIDATES only. It does not
 * decide whether a stream belongs to a tracker (see youtube-gating.ts) and
 * its "watching" numbers are only used for ordering — the authoritative
 * CCV always comes from videos.list keyed by explicit video id.
 *
 * Unofficial surface: parse defensively, fail soft, never throw into the
 * poll cycle. If YouTube changes the shape we log and return nothing,
 * which degrades to "no new streams discovered" rather than bad data.
 */
import axios from 'axios';
import logger from '../utils/logger';

/** The `sp` payload for search-tools → Type: Live. */
const LIVE_FILTER_SP = 'EgJAAQ%3D%3D';
const SCRAPE_TIMEOUT_MS = 12_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface YouTubeLiveCandidate {
  videoId: string;
  channelId: string | null;
  channelTitle: string | null;
  title: string;
  /** "N watching" as rendered — ordering hint only, never stored. */
  roughViewers: number | null;
}

const client = axios.create({
  timeout: SCRAPE_TIMEOUT_MS,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml',
  },
  maxRedirects: 5,
});

/** Pull `var ytInitialData = {...};` out of a results page. */
function extractInitialData(html: string): Record<string, unknown> | null {
  const m =
    html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) ??
    html.match(/window\["ytInitialData"\]\s*=\s*(\{.+?\});/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function runsText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { runs?: Array<{ text?: string }>; simpleText?: string };
  if (typeof n.simpleText === 'string') return n.simpleText;
  return (n.runs ?? []).map((r) => r.text ?? '').join('');
}

/**
 * Walk the renderer tree collecting videoRenderers. The results page nests
 * them differently depending on shelf layout, so we recurse rather than
 * assume a path.
 */
function collectVideoRenderers(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 12 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectVideoRenderers(child, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const vr = obj.videoRenderer;
  if (vr && typeof vr === 'object') out.push(vr as Record<string, unknown>);
  for (const key of Object.keys(obj)) {
    if (key === 'videoRenderer') continue;
    collectVideoRenderers(obj[key], out, depth + 1);
  }
}

function parseCandidates(data: Record<string, unknown>): YouTubeLiveCandidate[] {
  const renderers: Record<string, unknown>[] = [];
  collectVideoRenderers(data, renderers);

  const out: YouTubeLiveCandidate[] = [];
  const seen = new Set<string>();
  for (const v of renderers) {
    const videoId = typeof v.videoId === 'string' ? v.videoId : null;
    if (!videoId || seen.has(videoId)) continue;

    // "N watching" only appears on genuinely-live entries; upcoming and
    // finished VODs render "Scheduled for…" / "N views" and are skipped.
    const viewText = runsText(v.viewCountText);
    if (!/watching/i.test(viewText)) continue;
    const digits = viewText.replace(/[^0-9]/g, '');

    const owner = v.ownerText as { runs?: Array<Record<string, unknown>> } | undefined;
    const ownerRun = owner?.runs?.[0];
    const nav = ownerRun?.navigationEndpoint as
      | { browseEndpoint?: { browseId?: string } }
      | undefined;

    seen.add(videoId);
    out.push({
      videoId,
      channelId: nav?.browseEndpoint?.browseId ?? null,
      channelTitle: typeof ownerRun?.text === 'string' ? ownerRun.text : null,
      title: runsText(v.title),
      roughViewers: digits ? Number(digits) : null,
    });
  }
  return out;
}

/**
 * Live streams currently matching one search phrase. Returns [] on any
 * failure — discovery is best-effort by design.
 */
export async function discoverLiveByQuery(query: string): Promise<YouTubeLiveCandidate[]> {
  const url =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${LIVE_FILTER_SP}`;
  try {
    const { data: html } = await client.get<string>(url, {
      responseType: 'text',
      validateStatus: (s) => s < 500,
    });
    if (typeof html !== 'string') return [];
    const data = extractInitialData(html);
    if (!data) {
      logger.warn(`[YTDiscovery] no ytInitialData for "${query}" — page shape changed?`);
      return [];
    }
    const candidates = parseCandidates(data);
    logger.debug(`[YTDiscovery] "${query}" → ${candidates.length} live candidate(s)`);
    return candidates;
  } catch (err) {
    logger.warn(`[YTDiscovery] query "${query}" failed`, { error: (err as Error).message });
    return [];
  }
}

/**
 * Union of several search phrases, de-duplicated by video id. Queries run
 * sequentially with a small gap — politeness on an unofficial surface
 * matters more than shaving a second off a 10-minute discovery pass.
 */
export async function discoverLive(queries: string[]): Promise<YouTubeLiveCandidate[]> {
  const byId = new Map<string, YouTubeLiveCandidate>();
  for (const q of queries) {
    const found = await discoverLiveByQuery(q);
    for (const c of found) {
      const prev = byId.get(c.videoId);
      // Keep the richest record (channelId isn't always present).
      if (!prev || (prev.channelId == null && c.channelId != null)) byId.set(c.videoId, c);
    }
    if (queries.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
  return [...byId.values()];
}
