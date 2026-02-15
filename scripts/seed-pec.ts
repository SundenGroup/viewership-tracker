/**
 * Seed Script — PEC 2026 (PUBG EMEA Championship 2026)
 *
 * Creates a complete tournament structure:
 *   - 1 Series: "PUBG EMEA Championship 2026" / "PEC 2026"
 *   - 4 Stages:
 *       Stage 1: "Playoffs Weekend 1"    (3 days: March 7-9)
 *       Stage 2: "Playoffs Weekend 2"    (3 days: March 14-16)
 *       Stage 3: "Grand Finals Weekend 1" (3 days: March 28-30)
 *       Stage 4: "Grand Finals Weekend 2" (3 days: April 4-6)
 *   - 12 Broadcast Days: each 14:00–22:00 UTC
 *   - 5 Pre-added Channels:
 *       3 Twitch (en, ko, pt), 1 YouTube, 1 Kick
 *   - Discovery keywords and PUBG game IDs configured
 *
 * Usage:
 *   npx ts-node scripts/seed-pec.ts
 *
 * Flags:
 *   --clean    Remove existing PEC 2026 data before seeding
 */

import dotenv from 'dotenv';
dotenv.config();

import knex from 'knex';

const TEST_DB_URL = process.env.DATABASE_URL || 'postgresql://localhost/clutch_viewership_test';

const db = knex({
  client: 'pg',
  connection: TEST_DB_URL,
  pool: { min: 2, max: 10 },
});

// ── Constants ──────────────────────────────────────────────────────────────

const SERIES_SHORT_NAME = 'PEC 2026';

interface StageSpec {
  name: string;
  order: number;
  days: Array<{
    label: string;
    date: string; // YYYY-MM-DD
  }>;
}

const STAGES: StageSpec[] = [
  {
    name: 'Playoffs Weekend 1',
    order: 1,
    days: [
      { label: 'PW1 Day 1', date: '2026-03-07' },
      { label: 'PW1 Day 2', date: '2026-03-08' },
      { label: 'PW1 Day 3', date: '2026-03-09' },
    ],
  },
  {
    name: 'Playoffs Weekend 2',
    order: 2,
    days: [
      { label: 'PW2 Day 1', date: '2026-03-14' },
      { label: 'PW2 Day 2', date: '2026-03-15' },
      { label: 'PW2 Day 3', date: '2026-03-16' },
    ],
  },
  {
    name: 'Grand Finals Weekend 1',
    order: 3,
    days: [
      { label: 'GF1 Day 1', date: '2026-03-28' },
      { label: 'GF1 Day 2', date: '2026-03-29' },
      { label: 'GF1 Day 3', date: '2026-03-30' },
    ],
  },
  {
    name: 'Grand Finals Weekend 2',
    order: 4,
    days: [
      { label: 'GF2 Day 1', date: '2026-04-04' },
      { label: 'GF2 Day 2', date: '2026-04-05' },
      { label: 'GF2 Day 3', date: '2026-04-06' },
    ],
  },
];

interface ChannelSpec {
  platform: 'twitch' | 'youtube' | 'kick';
  channel_identifier: string;
  display_name: string;
  language: string;
  region: string;
  tier: 'primary' | 'secondary' | 'community';
}

const CHANNELS: ChannelSpec[] = [
  {
    platform: 'twitch',
    channel_identifier: 'pubg_battlegrounds',
    display_name: 'PUBG Esports',
    language: 'en',
    region: 'EU',
    tier: 'primary',
  },
  {
    platform: 'twitch',
    channel_identifier: 'pubg_kr',
    display_name: 'PUBG Esports Korea',
    language: 'ko',
    region: 'KR',
    tier: 'primary',
  },
  {
    platform: 'twitch',
    channel_identifier: 'pubg_latam',
    display_name: 'PUBG Esports LATAM',
    language: 'pt',
    region: 'BR',
    tier: 'secondary',
  },
  {
    platform: 'youtube',
    channel_identifier: 'UCu8mV5MdEqeB-PXfyY_N8Jw',
    display_name: 'PUBG Esports YouTube',
    language: 'en',
    region: 'Global',
    tier: 'primary',
  },
  {
    platform: 'kick',
    channel_identifier: 'pubg-esports',
    display_name: 'PUBG Esports Kick',
    language: 'en',
    region: 'Global',
    tier: 'secondary',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function section(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const shouldClean = process.argv.includes('--clean');

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  PEC 2026 Seed Script                                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`  Database: ${TEST_DB_URL}`);
  console.log(`  Clean mode: ${shouldClean ? 'YES — will remove existing data' : 'no'}`);

  try {
    // Run migrations to ensure schema exists
    section('1. Ensuring database schema');
    await db.migrate.latest({
      directory: './migrations',
      extension: 'ts',
    });
    console.log('  ✅ Migrations up to date');

    // Check for existing PEC 2026 data
    const existing = await db('tournament_series')
      .where('short_name', SERIES_SHORT_NAME)
      .first();

    if (existing) {
      if (shouldClean) {
        console.log(`  ⚠️  Found existing "${SERIES_SHORT_NAME}" (${existing.id}) — deleting...`);
        await db('tournament_series').where('id', existing.id).delete();
        console.log('  ✅ Existing data removed (cascade deleted stages, days, channels, snapshots)');
      } else {
        console.log(`  ⚠️  "${SERIES_SHORT_NAME}" already exists (${existing.id})`);
        console.log('  Run with --clean to replace existing data');
        console.log('  Exiting without changes.');
        await db.destroy();
        return;
      }
    }

    // ── Create Series ──────────────────────────────────────────────────
    section('2. Creating tournament series');

    const [series] = await db('tournament_series').insert({
      name: 'PUBG EMEA Championship 2026',
      short_name: SERIES_SHORT_NAME,
      game: 'PUBG: Battlegrounds',
      partner: 'Krafton',
      status: 'active',
      start_date: '2026-03-07',
      end_date: '2026-04-06',
      discovery_keywords: JSON.stringify(['PEC', 'PUBG EMEA', 'PUBG EMEA Championship']),
      discovery_game_ids: JSON.stringify({
        twitch: '493057',        // PUBG: Battlegrounds Twitch game ID
        youtube: 'PUBG',         // YouTube gaming category
      }),
      metadata: JSON.stringify({
        autoReports: {
          dailyRecap: true,
          stageReport: true,
          seriesReport: true,
          format: 'pdf',
        },
        blocklist: [],
      }),
    }).returning('*');

    console.log(`  ✅ Series: ${series.name}`);
    console.log(`     ID: ${series.id}`);
    console.log(`     Short name: ${series.short_name}`);
    console.log(`     Game: ${series.game}`);
    console.log(`     Partner: ${series.partner}`);
    console.log(`     Status: ${series.status}`);
    console.log(`     Dates: ${series.start_date} → ${series.end_date}`);
    console.log(`     Discovery keywords: ${JSON.stringify(series.discovery_keywords)}`);
    console.log(`     Discovery game IDs: ${JSON.stringify(series.discovery_game_ids)}`);
    console.log(`     Auto-reports: enabled (daily recap + stage report + series report)`);

    // ── Create Stages and Broadcast Days ───────────────────────────────
    section('3. Creating stages and broadcast days');

    let totalDays = 0;

    for (const spec of STAGES) {
      const [stage] = await db('stages').insert({
        series_id: series.id,
        name: spec.name,
        order: spec.order,
        start_date: spec.days[0]?.date,
        end_date: spec.days[spec.days.length - 1]?.date,
        status: 'draft',
      }).returning('*');

      console.log(`\n  📋 Stage ${spec.order}: ${spec.name}`);
      console.log(`     ID: ${stage.id}`);
      console.log(`     Dates: ${stage.start_date} → ${stage.end_date}`);

      for (const daySpec of spec.days) {
        const [day] = await db('broadcast_days').insert({
          stage_id: stage.id,
          series_id: series.id,
          label: daySpec.label,
          date: daySpec.date,
          broadcast_start: `${daySpec.date}T14:00:00Z`,
          broadcast_end: `${daySpec.date}T22:00:00Z`,
          status: 'scheduled',
        }).returning('*');

        totalDays++;
        console.log(`     📅 ${daySpec.label}: ${daySpec.date} (14:00–22:00 UTC) [${day.id}]`);
      }
    }

    console.log(`\n  ✅ Created ${STAGES.length} stages, ${totalDays} broadcast days`);

    // ── Create Channels ────────────────────────────────────────────────
    section('4. Creating channels');

    const createdChannels = [];
    for (const ch of CHANNELS) {
      const [channel] = await db('channels').insert({
        series_id: series.id,
        platform: ch.platform,
        channel_identifier: ch.channel_identifier,
        display_name: ch.display_name,
        language: ch.language,
        region: ch.region,
        tier: ch.tier,
        source: 'manual',
        is_active: true,
      }).returning('*');

      createdChannels.push(channel);
      console.log(`  📺 ${ch.display_name} [${ch.platform}] — ${ch.language}/${ch.region} (${ch.tier})`);
      console.log(`     ID: ${channel.id} | Identifier: ${ch.channel_identifier}`);
    }

    console.log(`\n  ✅ Created ${createdChannels.length} channels`);

    // ── Summary ────────────────────────────────────────────────────────
    section('Summary');

    const stageCount = await db('stages').where('series_id', series.id).count('* as count').first();
    const dayCount = await db('broadcast_days').where('series_id', series.id).count('* as count').first();
    const channelCount = await db('channels').where('series_id', series.id).count('* as count').first();

    console.log(`  Series:         ${series.name} (${series.short_name})`);
    console.log(`  Series ID:      ${series.id}`);
    console.log(`  Stages:         ${stageCount?.count}`);
    console.log(`  Broadcast Days: ${dayCount?.count}`);
    console.log(`  Channels:       ${channelCount?.count}`);
    console.log(`  Status:         ${series.status}`);
    console.log(`\n  To activate Stage 1 for polling, set its status to 'active':`);
    console.log(`    UPDATE stages SET status = 'active' WHERE series_id = '${series.id}' AND "order" = 1;`);
    console.log(`\n  To schedule broadcast days for live polling, their broadcast_start`);
    console.log(`  timestamps must be in the past (or near-future). The orchestrator`);
    console.log(`  automatically transitions scheduled → live → completed.`);
    console.log('');
  } catch (err) {
    console.error('\n💥 FATAL ERROR:', err);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

run();
