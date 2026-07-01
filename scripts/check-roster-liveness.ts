#!/usr/bin/env npx tsx
/**
 * Roster liveness probe.
 *
 * Checks whether channels are live RIGHT NOW — independent of their
 * day-tags — and flags any that are live on a day they are NOT pinned to
 * ("extend-pin candidates").
 *
 * Why this exists: the polling orchestrator DROPS a pinned channel's
 * snapshot on any day it isn't pinned to (polling-orchestrator.ts, the
 * `assignedDays && !assignedDays.has(day.id)` skip). So cross-day
 * liveness never lands in the DB, and for platforms discovery can't reach
 * (Soop / CHZZK / TikTok / NimoTV) you can't tell whether a watch-party
 * channel is also streaming on a day you didn't pin it to. This probe
 * polls the adapters directly so you can see it live and extend the pin.
 *
 * Run on the server (has the adapters, API keys, and DB):
 *   cd /opt/clutch-viewership-tracker
 *   npx tsx scripts/check-roster-liveness.ts            # default platform set
 *   npx tsx scripts/check-roster-liveness.ts --platforms=soop,chzzk,tiktok,nimotv,kick
 *   npx tsx scripts/check-roster-liveness.ts --pinned   # ALL day-pinned channels, every platform
 *
 * --pinned is the one to use when you want "every stream tagged for
 * another day but live today" across all platforms: it polls only
 * channels that have day-tags (bounded — ~200), so it covers Twitch /
 * YouTube / Kick without dragging in their thousands of untagged
 * auto-discovered channels. The stream title is shown so you can verify
 * each is actually a PNC stream.
 */
import knex from 'knex';
import { AdapterRegistry } from '../src/adapters';
import { config } from '../src/utils/config';

const DEFAULT_PLATFORMS = ['soop', 'chzzk', 'tiktok', 'nimotv', 'steam'];

async function main() {
  const args = process.argv.slice(2);
  const pinnedMode = args.includes('--pinned');
  const platformArg = args.find((a) => a.startsWith('--platforms='));
  const platforms = platformArg
    ? platformArg.split('=')[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_PLATFORMS;

  const db = knex({ client: 'pg', connection: config.database.url });
  try {
    const liveDays = await db('broadcast_days')
      .where('status', 'live')
      .select('id', 'series_id', 'label');
    if (liveDays.length === 0) {
      console.log('No live broadcast days right now — nothing to probe.');
      return;
    }
    const liveDayIds = new Set(liveDays.map((d) => d.id as string));
    const seriesIds = [...new Set(liveDays.map((d) => d.series_id as string))];
    console.log(`Live broadcast day(s): ${liveDays.map((d) => d.label).join(', ')}`);
    console.log(pinnedMode ? 'Mode: all day-pinned channels (every platform)\n' : `Platforms: ${platforms.join(', ')}\n`);

    let channelQuery = db('channels as c')
      .whereIn('c.series_id', seriesIds)
      .where('c.is_active', true)
      .select('c.id', 'c.platform', 'c.channel_identifier', 'c.display_name', 'c.source');
    if (pinnedMode) {
      // Only channels that HAVE day-tags — the set that can be "tagged
      // for another day". Bounded, so safe across all platforms.
      channelQuery = channelQuery.whereExists(
        db('channel_broadcast_days as cbd').whereRaw('cbd.channel_id = c.id'),
      );
    } else {
      channelQuery = channelQuery.whereIn('c.platform', platforms);
    }
    const channels = await channelQuery;

    if (channels.length === 0) {
      console.log('No matching active channels in the live series.');
      return;
    }

    const pins = await db('channel_broadcast_days')
      .whereIn('channel_id', channels.map((c) => c.id as string))
      .select('channel_id', 'broadcast_day_id');
    const pinMap = new Map<string, Set<string>>();
    for (const p of pins) {
      if (!pinMap.has(p.channel_id)) pinMap.set(p.channel_id, new Set());
      pinMap.get(p.channel_id)!.add(p.broadcast_day_id);
    }

    const registry = new AdapterRegistry();
    const probe = channels.map((c) => ({
      platform: c.platform as string,
      channelIdentifier: c.channel_identifier as string,
    }));
    console.log(`Polling ${probe.length} channel(s)…\n`);
    const snaps = await registry.getViewerCountsMultiPlatform(probe);
    const snapMap = new Map<string, { isLive: boolean; viewers: number; title: string }>();
    for (const s of snaps) {
      snapMap.set(`${s.platform}:${s.channelIdentifier.toLowerCase()}`, {
        isLive: s.isLive,
        viewers: s.concurrentViewers,
        title: s.title ?? '',
      });
    }

    interface Row {
      platform: string;
      id: string;
      name: string;
      live: boolean;
      viewers: number;
      title: string;
      pinnedDays: number;
      pinnedToday: boolean;
    }
    const rows: Row[] = channels.map((c) => {
      const snap = snapMap.get(`${c.platform}:${(c.channel_identifier as string).toLowerCase()}`);
      const cp = pinMap.get(c.id as string) ?? new Set<string>();
      return {
        platform: c.platform as string,
        id: c.channel_identifier as string,
        name: c.display_name as string,
        live: snap?.isLive ?? false,
        viewers: snap?.viewers ?? 0,
        title: snap?.title ?? '',
        pinnedDays: cp.size,
        pinnedToday: [...cp].some((d) => liveDayIds.has(d)),
      };
    });

    const liveNotPinnedToday = rows
      .filter((r) => r.live && !r.pinnedToday && r.pinnedDays > 0)
      .sort((a, b) => b.viewers - a.viewers);
    const liveAllDays = rows.filter((r) => r.live && r.pinnedDays === 0);
    const pinnedTodayOffline = rows.filter((r) => r.pinnedToday && !r.live);

    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const fmt = (r: Row) =>
      `  ${r.live ? 'LIVE ' : 'off  '}${r.platform.padEnd(7)}${String(r.viewers).padStart(7)}  ${r.id} (${clip(r.name, 14)})  pins=${r.pinnedDays}${r.pinnedToday ? ' [today]' : ''}  "${clip(r.title, 55)}"`;

    console.log('━━━ LIVE NOW but NOT pinned to today  → extend-pin candidates ━━━');
    console.log(liveNotPinnedToday.length ? liveNotPinnedToday.map(fmt).join('\n') : '  (none)');
    console.log('\n━━━ Pinned to today but currently OFFLINE ━━━');
    console.log(pinnedTodayOffline.length ? pinnedTodayOffline.map(fmt).join('\n') : '  (none)');
    console.log('\n━━━ Summary ━━━');
    const liveCount = rows.filter((r) => r.live).length;
    console.log(
      `  ${rows.length} probed · ${liveCount} live · ` +
        `${liveNotPinnedToday.length} live-but-unpinned-today · ` +
        `${pinnedTodayOffline.length} pinned-today-offline · ` +
        `${liveAllDays.length} live all-days (no pins)`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
