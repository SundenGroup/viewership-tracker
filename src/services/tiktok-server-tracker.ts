/**
 * Server-side TikTok viewer tracker.
 *
 * Fetches the live page of every active TikTok channel on a series with a
 * live broadcast day, once a minute, directly from the server; falls back
 * to the residential proxy (TIKTOK_PROXY_URL, else KICK_PROXY_URL) when the
 * direct fetch fails or comes back as a non-channel page. Readings go
 * through the same ingest as the relay pushes (tiktok-ingest.ts), tagged
 * source 'server-page'.
 *
 * Why: until 2026-09-03 the only TikTok source was a page scrape on a
 * laptop; when it was closed or on the wrong network, TikTok simply had no
 * data. Verified that day that the server reads the same number as the
 * residential scrape, to the viewer, minute by minute.
 *
 * A fetch that fails on both paths writes nothing (unknown is not zero).
 * Five consecutive passes with no successful fetch while channels are due
 * raise a data_anomaly notification. TIKTOK_SERVER_TRACKER=0 disables it.
 */
import axios from 'axios';
import db from '../utils/db';
import logger from '../utils/logger';
import { parseTikTokLivePage } from '../utils/tiktok-live-page';
import { ingestTikTokReadings, type TikTokReading } from './tiktok-ingest';
import { getPushNotifier } from './push-notifier';

const INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const CONCURRENCY = 3;
const SILENT_PASSES_BEFORE_ALERT = 5;
const ALERT_COOLDOWN_MS = 30 * 60_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface ServerTikTokPass {
  channels: number;
  live: number;
  direct: number;
  proxied: number;
  failed: number;
  ingest: { matched: number; inserted: number; updated: number; stale: number } | null;
}

let onIngested: ((seriesIds: string[]) => void) | null = null;
export function setTikTokServerBroadcast(fn: (seriesIds: string[]) => void): void {
  onIngested = fn;
}

function proxyConfig(): { host: string; port: number; auth?: { username: string; password: string }; protocol: string } | null {
  const raw = (process.env.TIKTOK_PROXY_URL || process.env.KICK_PROXY_URL || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
      ...(u.username ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } } : {}),
    };
  } catch {
    return null;
  }
}

/** Active TikTok channels of every series that has a live broadcast day. */
export async function listDueTikTokChannels(): Promise<Array<{ identifier: string; displayName: string }>> {
  const rows = await db('channels as c')
    .join('broadcast_days as bd', function () {
      this.on('bd.series_id', 'c.series_id').andOn('bd.status', db.raw("'live'"));
    })
    .where('c.platform', 'tiktok')
    .where('c.is_active', true)
    .distinct('c.channel_identifier', 'c.display_name')
    .select('c.channel_identifier', 'c.display_name');
  return rows.map((r: { channel_identifier: string; display_name: string }) => ({
    identifier: r.channel_identifier,
    displayName: r.display_name,
  }));
}

type Fetched =
  | { ok: true; via: 'direct' | 'proxy'; page: ReturnType<typeof parseTikTokLivePage> }
  | { ok: false; error: string };

async function fetchLivePage(identifier: string): Promise<Fetched> {
  const clean = identifier.replace(/^@/, '');
  const url = `https://www.tiktok.com/@${clean}/live`;
  const headers = { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' };
  const errors: string[] = [];
  const attempt = async (via: 'direct' | 'proxy'): Promise<Fetched | null> => {
    const proxy = via === 'proxy' ? proxyConfig() : null;
    if (via === 'proxy' && !proxy) return null;
    try {
      const res = await axios.get<string>(url, {
        headers,
        timeout: FETCH_TIMEOUT_MS,
        responseType: 'text',
        validateStatus: () => true,
        ...(proxy ? { proxy } : {}),
      });
      const page = parseTikTokLivePage(res.status === 200 ? res.data : null);
      if (page.unusable) {
        errors.push(`${via}: status ${res.status}, no room data`);
        return null;
      }
      return { ok: true, via, page };
    } catch (err) {
      errors.push(`${via}: ${(err as Error).message}`);
      return null;
    }
  };
  return (await attempt('direct')) ?? (await attempt('proxy')) ?? { ok: false, error: errors.join(' | ') };
}

let silentPasses = 0;
let lastAlertAt = 0;
let running = false;

export async function runTikTokServerPass(): Promise<ServerTikTokPass> {
  const channels = await listDueTikTokChannels();
  const pass: ServerTikTokPass = { channels: channels.length, live: 0, direct: 0, proxied: 0, failed: 0, ingest: null };
  if (channels.length === 0) return pass;

  const readings: TikTokReading[] = [];
  const failures: string[] = [];
  const summary: string[] = [];
  for (let i = 0; i < channels.length; i += CONCURRENCY) {
    const batch = channels.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (ch) => ({ ch, res: await fetchLivePage(ch.identifier) })));
    for (const { ch, res } of results) {
      if (!res.ok) {
        pass.failed++;
        failures.push(`${ch.identifier} (${res.error})`);
        continue;
      }
      if (res.via === 'direct') pass.direct++; else pass.proxied++;
      if (res.page.isLive) {
        pass.live++;
        summary.push(`${ch.identifier}=${res.page.viewers}${res.via === 'proxy' ? ' (proxy)' : ''}`);
      }
      // Offline is a real zero (the page said status != 2); a failed fetch is not pushed at all.
      readings.push({
        identifier: ch.identifier,
        viewers: res.page.isLive ? res.page.viewers : 0,
        title: res.page.title,
        displayName: res.page.displayName ?? ch.displayName,
        source: 'server-page',
      });
    }
  }

  if (readings.length > 0) {
    const r = await ingestTikTokReadings(readings, 'server-page');
    pass.ingest = { matched: r.matched, inserted: r.snapshotsInserted, updated: r.snapshotsUpdated, stale: r.stale };
    if ((r.snapshotsInserted > 0 || r.snapshotsUpdated > 0) && onIngested) {
      try { onIngested(r.affectedSeriesIds); } catch { /* broadcast is best effort */ }
    }
  }

  logger.info(
    `[TikTokServer] ${pass.live}/${pass.channels} live (direct ${pass.direct}, proxy ${pass.proxied}, failed ${pass.failed})` +
      (summary.length ? ` — ${summary.join(', ')}` : '') +
      (pass.ingest ? ` → ${pass.ingest.inserted} inserted, ${pass.ingest.updated} updated${pass.ingest.stale ? `, ${pass.ingest.stale} stale ignored` : ''}` : ''),
  );
  if (failures.length > 0) logger.warn(`[TikTokServer] fetch failed: ${failures.join('; ')}`);

  // Silence alert: nothing fetched for several minutes while channels are due.
  if (pass.failed === pass.channels) silentPasses++; else silentPasses = 0;
  if (silentPasses >= SILENT_PASSES_BEFORE_ALERT && Date.now() - lastAlertAt > ALERT_COOLDOWN_MS) {
    lastAlertAt = Date.now();
    getPushNotifier()
      .notify('data_anomaly', {
        title: 'TikTok tracking silent',
        body: `The server could not fetch any TikTok live page for ${silentPasses} minutes (direct and proxy). No TikTok rows are being written.`,
        tag: 'anomaly-tiktok-silent',
      })
      .catch(() => {});
  }
  return pass;
}

export function startTikTokServerTracker(): void {
  if (process.env.TIKTOK_SERVER_TRACKER === '0') {
    logger.info('[TikTokServer] disabled via TIKTOK_SERVER_TRACKER=0');
    return;
  }
  logger.info(`[TikTokServer] starting: live pages every ${INTERVAL_MS / 1000}s, direct with proxy fallback${proxyConfig() ? '' : ' (no proxy configured)'}`);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runTikTokServerPass();
    } catch (err) {
      logger.error('[TikTokServer] pass failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, INTERVAL_MS);
}
