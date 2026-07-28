/**
 * Fix PNC2026 co-streamer data for 2026-06-23.
 *
 * Actions:
 *  1. Delete ALL today's snapshots for kr1stw, pubg_taiwan, pubgjapan
 *  2. Poll Helix for current per-channel values and insert one snapshot each
 *  3. Delete today's pubg_battlegrounds snapshots (inflated from relay bleed)
 *  4. Insert official Twitch Stream Session CSV data for pubg_battlegrounds
 *
 * Run on the production server:
 *   DATABASE_URL=... TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... \
 *     npx ts-node scripts/fix-pnc2026-costream-data.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import knex from 'knex';
import { TwitchAdapter } from '../src/adapters/twitch';

// ─── Constants ───────────────────────────────────────────────────────────────

const TODAY_START = '2026-06-23T00:00:00Z';
const TODAY_END   = '2026-06-24T00:00:00Z';

// Channel IDs (UUIDs from channels table)
const CHANNEL_KR1STW       = '50abfce7-6765-4744-9385-a142b7cab4aa';
const CHANNEL_PUBG_TAIWAN  = 'b892961c-3ad1-4c7b-a82f-ce7ec1eacbe4';
const CHANNEL_PUBG_JAPAN   = 'e987b9fa-6aa3-49ed-8018-3ba7da13dcc8';
const CHANNEL_PUBG_BG      = 'ee8e9945-dace-4c17-94ea-f8c0309ccad6';

// Twitch login names (for Helix lookup)
const CO_STREAMERS: Array<{ channelId: string; login: string }> = [
  { channelId: CHANNEL_KR1STW,      login: 'kr1stw' },
  { channelId: CHANNEL_PUBG_TAIWAN, login: 'pubg_taiwan' },
  { channelId: CHANNEL_PUBG_JAPAN,  login: 'pubgjapan' },
];

// PNC2026 event IDs
const PNC2026_SERIES_ID  = '146027a7-334f-4214-86c6-2a6baa0a332b';
const PNC2026_STAGE_ID   = '5df39262-6cdf-48b3-b6f8-88cda19c5bd7';
const PNC2026_DAY_ID     = 'cc83a55e-6f04-402e-b430-08d10ba54f65';

// CSV data from "Stream Session from 6_23_2026 to 6_23_2026.csv"
// Format: [CEST time string, average_viewers]
// CEST = UTC+2; timestamps become 2026-06-23T{HH-2}:{MM}:00Z
const PUBG_BG_CSV: Array<[string, number]> = [
  ['11:01 AM', 83], ['11:02 AM', 447], ['11:03 AM', 538], ['11:04 AM', 498],
  ['11:05 AM', 505], ['11:06 AM', 547], ['11:07 AM', 704], ['11:08 AM', 761],
  ['11:09 AM', 812], ['11:10 AM', 966], ['11:11 AM', 978], ['11:12 AM', 1081],
  ['11:13 AM', 1201], ['11:14 AM', 1253], ['11:15 AM', 1287], ['11:16 AM', 1380],
  ['11:17 AM', 1426], ['11:18 AM', 1483], ['11:19 AM', 1555], ['11:20 AM', 1591],
  ['11:21 AM', 1674], ['11:22 AM', 1751], ['11:23 AM', 1793], ['11:24 AM', 1852],
  ['11:25 AM', 1864], ['11:26 AM', 1913], ['11:27 AM', 1982], ['11:28 AM', 2038],
  ['11:29 AM', 2041], ['11:30 AM', 2060], ['11:31 AM', 2092], ['11:32 AM', 2161],
  ['11:33 AM', 2259], ['11:34 AM', 2263], ['11:35 AM', 2323], ['11:36 AM', 2347],
  ['11:37 AM', 2388], ['11:38 AM', 2435], ['11:39 AM', 2513], ['11:40 AM', 2590],
  ['11:41 AM', 2639], ['11:42 AM', 2690], ['11:43 AM', 2700], ['11:44 AM', 2766],
  ['11:45 AM', 2839], ['11:46 AM', 2901], ['11:47 AM', 3006], ['11:48 AM', 2994],
  ['11:49 AM', 3013], ['11:50 AM', 3022], ['11:51 AM', 3101], ['11:52 AM', 3144],
  ['11:53 AM', 3204], ['11:54 AM', 3297], ['11:55 AM', 3364], ['11:56 AM', 3466],
  ['11:57 AM', 3515], ['11:58 AM', 3604], ['11:59 AM', 3710],
  ['12:00 PM', 3757], ['12:01 PM', 3894], ['12:02 PM', 4032], ['12:03 PM', 4128],
  ['12:04 PM', 4158], ['12:05 PM', 4219], ['12:06 PM', 4279], ['12:07 PM', 4392],
  ['12:08 PM', 4355], ['12:09 PM', 4433], ['12:10 PM', 4505], ['12:11 PM', 4648],
  ['12:12 PM', 4754], ['12:13 PM', 4838], ['12:14 PM', 4835], ['12:15 PM', 4877],
  ['12:16 PM', 4952], ['12:17 PM', 4985], ['12:18 PM', 5041], ['12:19 PM', 5090],
  ['12:20 PM', 5065], ['12:21 PM', 5154], ['12:22 PM', 5158], ['12:23 PM', 5253],
  ['12:24 PM', 5269], ['12:25 PM', 5293], ['12:26 PM', 5378], ['12:27 PM', 5478],
  ['12:28 PM', 5542], ['12:29 PM', 5380], ['12:30 PM', 5138], ['12:31 PM', 4913],
  ['12:32 PM', 4835], ['12:33 PM', 4824], ['12:34 PM', 4799], ['12:35 PM', 4863],
  ['12:36 PM', 4875], ['12:37 PM', 4848], ['12:38 PM', 4856], ['12:39 PM', 4852],
  ['12:40 PM', 4858], ['12:41 PM', 4881], ['12:42 PM', 4920], ['12:43 PM', 4984],
  ['12:44 PM', 4999], ['12:45 PM', 5078], ['12:46 PM', 5151], ['12:47 PM', 5197],
  ['12:48 PM', 5307], ['12:49 PM', 5382], ['12:50 PM', 5394], ['12:51 PM', 5436],
  ['12:52 PM', 5480], ['12:53 PM', 5482], ['12:54 PM', 5528], ['12:55 PM', 5580],
  ['12:56 PM', 5634], ['12:57 PM', 5700], ['12:58 PM', 5726], ['12:59 PM', 5742],
  ['1:00 PM', 5768], ['1:01 PM', 5782], ['1:02 PM', 5827], ['1:03 PM', 5839],
  ['1:04 PM', 5894], ['1:05 PM', 5927], ['1:06 PM', 5917], ['1:07 PM', 5934],
  ['1:08 PM', 6048], ['1:09 PM', 5802], ['1:10 PM', 5631], ['1:11 PM', 5478],
  ['1:12 PM', 5397], ['1:13 PM', 5341], ['1:14 PM', 5271], ['1:15 PM', 5276],
  ['1:16 PM', 5198], ['1:17 PM', 5217], ['1:18 PM', 5250], ['1:19 PM', 5239],
  ['1:20 PM', 5297], ['1:21 PM', 5379], ['1:22 PM', 5497], ['1:23 PM', 5560],
  ['1:24 PM', 5604], ['1:25 PM', 5649], ['1:26 PM', 5759], ['1:27 PM', 5796],
  ['1:28 PM', 5845], ['1:29 PM', 5887], ['1:30 PM', 5899], ['1:31 PM', 5949],
  ['1:32 PM', 5996], ['1:33 PM', 6078], ['1:34 PM', 6045], ['1:35 PM', 6128],
  ['1:36 PM', 6102], ['1:37 PM', 6139], ['1:38 PM', 6147], ['1:39 PM', 6170],
  ['1:40 PM', 6195], ['1:41 PM', 6230], ['1:42 PM', 6225], ['1:43 PM', 6278],
  ['1:44 PM', 6280], ['1:45 PM', 6308], ['1:46 PM', 6250], ['1:47 PM', 6337],
  ['1:48 PM', 6332], ['1:49 PM', 6370], ['1:50 PM', 6460], ['1:51 PM', 6247],
  ['1:52 PM', 5977], ['1:53 PM', 5840], ['1:54 PM', 5703], ['1:55 PM', 5728],
  ['1:56 PM', 5691], ['1:57 PM', 5646], ['1:58 PM', 5655], ['1:59 PM', 5675],
  ['2:00 PM', 5774], ['2:01 PM', 5842], ['2:02 PM', 5882], ['2:03 PM', 5902],
  ['2:04 PM', 5931], ['2:05 PM', 6002], ['2:06 PM', 6096], ['2:07 PM', 6135],
  ['2:08 PM', 6149], ['2:09 PM', 6152], ['2:10 PM', 6138], ['2:11 PM', 6209],
  ['2:12 PM', 6249], ['2:13 PM', 6262], ['2:14 PM', 6359], ['2:15 PM', 6342],
  ['2:16 PM', 6414], ['2:17 PM', 6398], ['2:18 PM', 6447], ['2:19 PM', 6461],
  ['2:20 PM', 6517], ['2:21 PM', 6523], ['2:22 PM', 6571], ['2:23 PM', 6681],
  ['2:24 PM', 6568], ['2:25 PM', 6592], ['2:26 PM', 6643], ['2:27 PM', 6267],
  ['2:28 PM', 6066], ['2:29 PM', 5937], ['2:30 PM', 5934], ['2:31 PM', 5849],
  ['2:32 PM', 5796], ['2:33 PM', 5766], ['2:34 PM', 5710], ['2:35 PM', 5674],
  ['2:36 PM', 5660], ['2:37 PM', 5692], ['2:38 PM', 5753], ['2:39 PM', 5821],
  ['2:40 PM', 5855], ['2:41 PM', 5868], ['2:42 PM', 5783], ['2:43 PM', 5832],
  ['2:44 PM', 5834], ['2:45 PM', 5846], ['2:46 PM', 5879], ['2:47 PM', 5961],
  ['2:48 PM', 5997], ['2:49 PM', 6044], ['2:50 PM', 6051], ['2:51 PM', 6105],
  ['2:52 PM', 6118], ['2:53 PM', 6120], ['2:54 PM', 6190], ['2:55 PM', 6311],
  ['2:56 PM', 6358], ['2:57 PM', 6360], ['2:58 PM', 6408], ['2:59 PM', 6475],
  ['3:00 PM', 6544], ['3:01 PM', 6593], ['3:02 PM', 6612], ['3:03 PM', 6615],
  ['3:04 PM', 6625], ['3:05 PM', 6649], ['3:06 PM', 6689], ['3:07 PM', 6732],
  ['3:08 PM', 6761], ['3:09 PM', 6797], ['3:10 PM', 6781], ['3:11 PM', 6873],
  ['3:12 PM', 6916], ['3:13 PM', 6945], ['3:14 PM', 6948], ['3:15 PM', 7044],
  ['3:16 PM', 6540], ['3:17 PM', 6172], ['3:18 PM', 5892], ['3:19 PM', 5756],
  ['3:20 PM', 5534], ['3:21 PM', 5341], ['3:22 PM', 5229], ['3:23 PM', 5060],
  ['3:24 PM', 4913], ['3:25 PM', 4808], ['3:26 PM', 4669], ['3:27 PM', 4551],
  ['3:28 PM', 4445], ['3:29 PM', 4361], ['3:30 PM', 4314], ['3:31 PM', 4146],
  ['3:32 PM', 4108], ['3:33 PM', 4126], ['3:34 PM', 3769],
  // Stream ended here — 3:35 PM onward shows 0 viewers
  ['3:35 PM', 0], ['3:36 PM', 0], ['3:37 PM', 0], ['3:38 PM', 0],
  ['3:39 PM', 0], ['3:40 PM', 0], ['3:41 PM', 0], ['3:42 PM', 0],
  ['3:43 PM', 0], ['3:44 PM', 0],
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cestToUtc(timeStr: string): string {
  // "11:01 AM" / "3:15 PM" → "2026-06-23T09:01:00Z"
  const [timePart, period] = timeStr.split(' ');
  const [hourStr, minStr] = timePart.split(':');
  let hour = parseInt(hourStr, 10);
  const min = parseInt(minStr, 10);
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  // CEST = UTC+2
  const utcHour = hour - 2;
  const utcDate = utcHour < 0 ? '2026-06-22' : '2026-06-23';
  const h = ((utcHour % 24) + 24) % 24;
  return `${utcDate}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
  });

  const twitch = new TwitchAdapter();

  try {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  PNC2026 Data Fix — 2026-06-23');
    console.log('══════════════════════════════════════════════════════════\n');

    // ── Step 1: Preview counts before delete ─────────────────────────────────
    console.log('STEP 1: Preview existing snapshot counts');

    for (const ch of CO_STREAMERS) {
      const [{ count }] = await db('viewership_snapshots')
        .count('* as count')
        .where('channel_id', ch.channelId)
        .whereBetween('timestamp', [TODAY_START, TODAY_END]);
      console.log(`  ${ch.login}: ${count} rows today`);
    }

    const [{ count: bgCount }] = await db('viewership_snapshots')
      .count('* as count')
      .where('channel_id', CHANNEL_PUBG_BG)
      .whereBetween('timestamp', [TODAY_START, TODAY_END]);
    console.log(`  pubg_battlegrounds: ${bgCount} rows today`);

    // ── Step 2: Capture broadcast_day/stage/series IDs for co-streamers ──────
    console.log('\nSTEP 2: Capture event context from existing co-streamer rows');
    const coStreamerContext: Record<string, { broadcast_day_id: string | null; stage_id: string | null; series_id: string | null; platform: string | null; language: string | null }> = {};

    for (const ch of CO_STREAMERS) {
      const row = await db('viewership_snapshots')
        .select('broadcast_day_id', 'stage_id', 'series_id', 'platform', 'language')
        .where('channel_id', ch.channelId)
        .whereBetween('timestamp', [TODAY_START, TODAY_END])
        .whereNotNull('broadcast_day_id')
        .orderBy('timestamp', 'desc')
        .first();

      if (row) {
        coStreamerContext[ch.channelId] = row;
        console.log(`  ${ch.login}: broadcast_day=${row.broadcast_day_id}, stage=${row.stage_id}, series=${row.series_id}`);
      } else {
        // Fallback to PNC2026 IDs if no existing rows have context
        coStreamerContext[ch.channelId] = {
          broadcast_day_id: PNC2026_DAY_ID,
          stage_id: PNC2026_STAGE_ID,
          series_id: PNC2026_SERIES_ID,
          platform: 'twitch',
          language: null,
        };
        console.log(`  ${ch.login}: no context row found, using PNC2026 fallback IDs`);
      }
    }

    // ── Step 3: Poll Helix for current co-streamer values ────────────────────
    console.log('\nSTEP 3: Poll Helix for current per-channel viewer counts');
    const logins = CO_STREAMERS.map((c) => c.login);
    const helixResults = await twitch.getViewerCounts(logins);
    const helixMap = new Map(helixResults.map((r) => [r.channelIdentifier.toLowerCase(), r]));
    for (const r of helixResults) {
      console.log(`  ${r.channelIdentifier}: ${r.isLive ? `LIVE ${r.concurrentViewers}` : 'offline'}`);
    }

    // ── Step 4: Delete + re-insert co-streamer data ───────────────────────────
    console.log('\nSTEP 4: Delete all today\'s co-streamer snapshots');

    await db.transaction(async (trx) => {
      const coIds = CO_STREAMERS.map((c) => c.channelId);
      const deleted = await trx('viewership_snapshots')
        .whereIn('channel_id', coIds)
        .whereBetween('timestamp', [TODAY_START, TODAY_END])
        .delete();
      console.log(`  Deleted ${deleted} rows`);

      // Verify deletion
      const [{ count: remaining }] = await trx('viewership_snapshots')
        .count('* as count')
        .whereIn('channel_id', coIds)
        .whereBetween('timestamp', [TODAY_START, TODAY_END]);
      if (Number(remaining) !== 0) {
        throw new Error(`Deletion verification failed: ${remaining} rows remain`);
      }
      console.log('  Verified: 0 rows remain');

      // Insert Helix snapshot for each channel
      const now = new Date().toISOString();
      const inserts = [];
      for (const ch of CO_STREAMERS) {
        const snap = helixMap.get(ch.login.toLowerCase());
        const ctx = coStreamerContext[ch.channelId];
        if (snap) {
          inserts.push({
            channel_id: ch.channelId,
            concurrent_viewers: snap.concurrentViewers,
            timestamp: now,
            broadcast_day_id: ctx.broadcast_day_id,
            stage_id: ctx.stage_id,
            series_id: ctx.series_id,
            platform: ctx.platform || 'twitch',
            language: snap.language ?? ctx.language ?? null,
          });
          console.log(`  Inserting ${ch.login}: ${snap.concurrentViewers} viewers @ ${now}`);
        }
      }
      if (inserts.length > 0) {
        await trx('viewership_snapshots').insert(inserts);
      }
    });

    // ── Step 5: Delete pubg_battlegrounds today ───────────────────────────────
    console.log('\nSTEP 5: Delete today\'s pubg_battlegrounds snapshots');
    await db.transaction(async (trx) => {
      const deleted = await trx('viewership_snapshots')
        .where('channel_id', CHANNEL_PUBG_BG)
        .whereBetween('timestamp', [TODAY_START, TODAY_END])
        .delete();
      console.log(`  Deleted ${deleted} rows`);

      const [{ count: remaining }] = await trx('viewership_snapshots')
        .count('* as count')
        .where('channel_id', CHANNEL_PUBG_BG)
        .whereBetween('timestamp', [TODAY_START, TODAY_END]);
      if (Number(remaining) !== 0) {
        throw new Error(`Deletion verification failed: ${remaining} rows remain`);
      }
      console.log('  Verified: 0 rows remain');
    });

    // ── Step 6: Insert CSV data for pubg_battlegrounds ────────────────────────
    console.log('\nSTEP 6: Insert official Stream Session CSV data (283 rows)');
    const csvRows = PUBG_BG_CSV.map(([timeStr, viewers]) => ({
      channel_id: CHANNEL_PUBG_BG,
      concurrent_viewers: viewers,
      timestamp: cestToUtc(timeStr),
      broadcast_day_id: PNC2026_DAY_ID,
      stage_id: PNC2026_STAGE_ID,
      series_id: PNC2026_SERIES_ID,
      platform: 'twitch',
      language: 'en',
    }));

    // Insert in batches of 100
    for (let i = 0; i < csvRows.length; i += 100) {
      await db('viewership_snapshots').insert(csvRows.slice(i, i + 100));
    }
    console.log(`  Inserted ${csvRows.length} rows`);

    const peak = PUBG_BG_CSV.reduce((best, [t, v]) => v > best[1] ? [t, v] : best, ['', 0]);
    console.log(`  Peak: ${peak[1]} viewers @ ${peak[0]} CEST (${cestToUtc(peak[0])} UTC)`);

    // ── Final summary ─────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  Done. Final counts for 2026-06-23:');
    for (const ch of CO_STREAMERS) {
      const [{ count }] = await db('viewership_snapshots')
        .count('* as count')
        .where('channel_id', ch.channelId)
        .whereBetween('timestamp', [TODAY_START, TODAY_END]);
      console.log(`  ${ch.login}: ${count} rows`);
    }
    const [{ count: bgFinal }] = await db('viewership_snapshots')
      .count('* as count')
      .where('channel_id', CHANNEL_PUBG_BG)
      .whereBetween('timestamp', [TODAY_START, TODAY_END]);
    console.log(`  pubg_battlegrounds: ${bgFinal} rows`);
    console.log('══════════════════════════════════════════════════════════\n');

  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
