/**
 * End-to-end REST API verification script.
 *
 * Walks through the full lifecycle:
 *   series → stage → broadcast days → channels → poll → viewership → export → cleanup
 *
 * Requires:
 *   - API server running on PORT (default 3333)
 *   - PostgreSQL (clutch_viewership_test)
 *   - Twitch credentials in .env
 *
 * Usage: npx ts-node scripts/verify-api.ts
 */

import axios, { AxiosError } from 'axios';

const BASE = process.env.API_BASE || 'http://localhost:3333';
const api = axios.create({ baseURL: BASE, validateStatus: () => true });

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

// Track IDs for cleanup
let seriesId: string;
let stageId: string;
let dayIds: string[] = [];
let channelIds: string[] = [];

async function run() {
  // ── Health check ──────────────────────────────────────────────────
  section('0. Health check');
  const health = await api.get('/health');
  console.log(`  GET /health → ${health.status}: ${JSON.stringify(health.data)}`);
  assert('Health check 200', health.status === 200);

  // ═══════════════════════════════════════════════════════════════════
  // (a) POST /api/series — Create test series
  // ═══════════════════════════════════════════════════════════════════
  section('(a) POST /api/series — Create series');
  const seriesRes = await api.post('/api/series', {
    name: 'PEC 2026',
    short_name: 'PEC26',
    game: 'Counter-Strike',
    partner: 'PGL',
    status: 'active',
    start_date: '2026-02-10',
    end_date: '2026-02-16',
  });
  console.log(`  POST /api/series → ${seriesRes.status}`);
  console.log(`  Series: ${seriesRes.data.name} (${seriesRes.data.id})`);
  assert('Status 201', seriesRes.status === 201);
  assert('Has id', !!seriesRes.data.id);
  assert('Name matches', seriesRes.data.name === 'PEC 2026');
  seriesId = seriesRes.data.id;

  // Test validation
  const badSeries = await api.post('/api/series', {});
  assert('Missing name → 400', badSeries.status === 400);

  // ═══════════════════════════════════════════════════════════════════
  // (b) POST /api/series/:id/stages — Create stage
  // ═══════════════════════════════════════════════════════════════════
  section('(b) POST /api/series/:id/stages — Create stage');
  const stageRes = await api.post(`/api/series/${seriesId}/stages`, {
    name: 'Playoffs Weekend 1',
    order: 1,
    status: 'active',
    start_date: '2026-02-10',
    end_date: '2026-02-12',
  });
  console.log(`  POST /api/series/${seriesId}/stages → ${stageRes.status}`);
  console.log(`  Stage: ${stageRes.data.name} (${stageRes.data.id})`);
  assert('Status 201', stageRes.status === 201);
  assert('Has series_id', stageRes.data.series_id === seriesId);
  stageId = stageRes.data.id;

  // Validation
  const badStage = await api.post(`/api/series/${seriesId}/stages`, { name: 'No order' });
  assert('Missing order → 400', badStage.status === 400);

  // ═══════════════════════════════════════════════════════════════════
  // (c) POST /api/stages/:id/days — Create 3 broadcast days
  // ═══════════════════════════════════════════════════════════════════
  section('(c) POST /api/stages/:id/days — Create 3 broadcast days');

  const now = Date.now();
  const dayConfigs = [
    { label: 'Friday', date: '2026-02-10', broadcast_start: new Date(now - 60 * 60_000).toISOString(), broadcast_end: new Date(now + 3 * 60 * 60_000).toISOString() },
    { label: 'Saturday', date: '2026-02-11', broadcast_start: new Date(now + 24 * 60 * 60_000).toISOString(), broadcast_end: new Date(now + 27 * 60 * 60_000).toISOString() },
    { label: 'Sunday', date: '2026-02-12', broadcast_start: new Date(now + 48 * 60 * 60_000).toISOString(), broadcast_end: new Date(now + 51 * 60 * 60_000).toISOString() },
  ];

  for (const dc of dayConfigs) {
    const dayRes = await api.post(`/api/stages/${stageId}/days`, dc);
    console.log(`  POST /api/stages/${stageId}/days → ${dayRes.status} — ${dayRes.data.label}`);
    assert(`${dc.label} created (201)`, dayRes.status === 201);
    assert(`${dc.label} has stage_id`, dayRes.data.stage_id === stageId);
    assert(`${dc.label} has series_id`, dayRes.data.series_id === seriesId);
    dayIds.push(dayRes.data.id);
  }

  // ═══════════════════════════════════════════════════════════════════
  // (d) POST /api/series/:id/channels — Add 2 channels
  // ═══════════════════════════════════════════════════════════════════
  section('(d) POST /api/series/:id/channels — Add channels');

  const ch1Res = await api.post(`/api/series/${seriesId}/channels`, {
    platform: 'twitch',
    channel_identifier: 'esl_csgo',
    display_name: 'ESL CS:GO',
    language: 'en',
    region: 'EU',
    tier: 'primary',
    is_active: true,
  });
  console.log(`  Channel 1: ${ch1Res.data.display_name} [${ch1Res.data.platform}] → ${ch1Res.status}`);
  assert('Channel 1 created (201)', ch1Res.status === 201);
  channelIds.push(ch1Res.data.id);

  const ch2Res = await api.post(`/api/series/${seriesId}/channels`, {
    platform: 'twitch',
    channel_identifier: 'shroud',
    display_name: 'shroud',
    language: 'en',
    region: 'NA',
    tier: 'secondary',
    is_active: true,
  });
  console.log(`  Channel 2: ${ch2Res.data.display_name} [${ch2Res.data.platform}] → ${ch2Res.status}`);
  assert('Channel 2 created (201)', ch2Res.status === 201);
  channelIds.push(ch2Res.data.id);

  // Validation
  const badChannel = await api.post(`/api/series/${seriesId}/channels`, { platform: 'invalid' });
  assert('Invalid platform → 400', badChannel.status === 400);

  // ═══════════════════════════════════════════════════════════════════
  // (e) PUT /api/days/:id/status — Set Day 1 to 'live'
  // ═══════════════════════════════════════════════════════════════════
  section('(e) PUT /api/days/:id/status — Set Day 1 to live');
  const liveRes = await api.put(`/api/days/${dayIds[0]}/status`, { status: 'live' });
  console.log(`  PUT /api/days/${dayIds[0]}/status → ${liveRes.status}`);
  assert('Status 200', liveRes.status === 200);
  assert('Day 1 is now live', liveRes.data.status === 'live');

  // Validation
  const badStatus = await api.put(`/api/days/${dayIds[0]}/status`, { status: 'invalid' });
  assert('Invalid status → 400', badStatus.status === 400);

  // ═══════════════════════════════════════════════════════════════════
  // (f) POST /api/polling/trigger — Manual poll cycle
  // ═══════════════════════════════════════════════════════════════════
  section('(f) POST /api/polling/trigger — Manual poll cycle');
  const pollRes = await api.post('/api/polling/trigger');
  console.log(`  POST /api/polling/trigger → ${pollRes.status}`);
  console.log(`  channelsPolled: ${pollRes.data.channelsPolled}`);
  console.log(`  snapshotsCreated: ${pollRes.data.snapshotsCreated}`);
  console.log(`  totalCCV: ${pollRes.data.totalCCV}`);
  console.log(`  duration: ${pollRes.data.duration}ms`);
  console.log(`  errors: ${pollRes.data.errors?.length > 0 ? pollRes.data.errors.join(', ') : 'none'}`);
  assert('Status 200', pollRes.status === 200);
  assert('Polled 2 channels', pollRes.data.channelsPolled === 2);
  assert('Created 2 snapshots', pollRes.data.snapshotsCreated === 2);
  assert('No errors', pollRes.data.errors?.length === 0);

  // ═══════════════════════════════════════════════════════════════════
  // (g) GET /api/polling/status — Confirm poll ran
  // ═══════════════════════════════════════════════════════════════════
  section('(g) GET /api/polling/status');
  const statusRes = await api.get('/api/polling/status');
  console.log(`  GET /api/polling/status → ${statusRes.status}`);
  console.log(`  state: ${statusRes.data.state}`);
  console.log(`  activeBroadcastDays: ${statusRes.data.activeBroadcastDays}`);
  assert('Status 200', statusRes.status === 200);
  assert('State is stopped (not started via API)', statusRes.data.state === 'stopped');
  assert('Has lastPollResult', statusRes.data.lastPollResult !== null);

  // ═══════════════════════════════════════════════════════════════════
  // (h) GET /api/viewership/live/:seriesId — Live CCV
  // ═══════════════════════════════════════════════════════════════════
  section('(h) GET /api/viewership/live/:seriesId');
  const liveViewsRes = await api.get(`/api/viewership/live/${seriesId}`);
  console.log(`  GET /api/viewership/live/${seriesId} → ${liveViewsRes.status}`);
  console.log(`  totalCCV: ${liveViewsRes.data.totalCCV}`);
  console.log(`  channelCount: ${liveViewsRes.data.channelCount}`);
  console.log(`  liveChannels: ${liveViewsRes.data.liveChannels}`);
  if (liveViewsRes.data.channels) {
    for (const ch of liveViewsRes.data.channels) {
      console.log(`    ${ch.displayName}: ${ch.concurrentViewers} viewers [${ch.platform}]`);
    }
  }
  assert('Status 200', liveViewsRes.status === 200);
  assert('Has channels array', Array.isArray(liveViewsRes.data.channels));
  assert('2 channels returned', liveViewsRes.data.channels.length === 2);
  assert('Each channel has concurrentViewers', liveViewsRes.data.channels.every((c: { concurrentViewers: number }) => typeof c.concurrentViewers === 'number'));

  // Validation
  const badUUID = await api.get('/api/viewership/live/not-a-uuid');
  assert('Invalid UUID → 400', badUUID.status === 400);

  // ═══════════════════════════════════════════════════════════════════
  // (i) GET /api/viewership/metrics — Metrics for Day 1
  // ═══════════════════════════════════════════════════════════════════
  section('(i) GET /api/viewership/metrics');
  const metricsRes = await api.get('/api/viewership/metrics', {
    params: { scope: 'day', id: dayIds[0] },
  });
  console.log(`  GET /api/viewership/metrics?scope=day&id=${dayIds[0]} → ${metricsRes.status}`);
  console.log(`  peakCCV: ${JSON.stringify(metricsRes.data.peakCCV)}`);
  console.log(`  avgCCV: ${metricsRes.data.avgCCV}`);
  console.log(`  totalViewedHours: ${metricsRes.data.totalViewedHours}`);
  console.log(`  platformBreakdown: ${metricsRes.data.platformBreakdown?.length} entries`);
  console.log(`  languageBreakdown: ${metricsRes.data.languageBreakdown?.length} entries`);
  console.log(`  regionBreakdown: ${metricsRes.data.regionBreakdown?.length} entries`);
  console.log(`  channelLeaderboard: ${metricsRes.data.channelLeaderboard?.length} entries`);
  assert('Status 200', metricsRes.status === 200);
  assert('Has peakCCV', metricsRes.data.peakCCV !== undefined);
  assert('Has avgCCV (number)', typeof metricsRes.data.avgCCV === 'number');
  assert('Has totalViewedHours (number)', typeof metricsRes.data.totalViewedHours === 'number');
  assert('Has platformBreakdown (array)', Array.isArray(metricsRes.data.platformBreakdown));
  assert('Has languageBreakdown (array)', Array.isArray(metricsRes.data.languageBreakdown));
  assert('Has regionBreakdown (array)', Array.isArray(metricsRes.data.regionBreakdown));
  assert('Has channelLeaderboard (array)', Array.isArray(metricsRes.data.channelLeaderboard));

  // Missing scope
  const badMetrics = await api.get('/api/viewership/metrics');
  assert('Missing scope → 400', badMetrics.status === 400);

  // ═══════════════════════════════════════════════════════════════════
  // (j) GET /api/viewership/timeseries — Chart data
  // ═══════════════════════════════════════════════════════════════════
  section('(j) GET /api/viewership/timeseries');
  const tsRes = await api.get('/api/viewership/timeseries', {
    params: { scope: 'day', id: dayIds[0], groupBy: 'platform', interval: 60 },
  });
  console.log(`  GET /api/viewership/timeseries → ${tsRes.status}`);
  console.log(`  data points: ${tsRes.data.data?.length}`);
  if (tsRes.data.data?.length > 0) {
    console.log(`  Sample: ${JSON.stringify(tsRes.data.data[0])}`);
  }
  assert('Status 200', tsRes.status === 200);
  assert('Has data array', Array.isArray(tsRes.data.data));
  assert('groupBy = platform', tsRes.data.groupBy === 'platform');
  assert('interval = 60', tsRes.data.interval === 60);

  // ═══════════════════════════════════════════════════════════════════
  // (k) GET /api/export/csv — CSV export
  // ═══════════════════════════════════════════════════════════════════
  section('(k) GET /api/export/csv');
  const csvRes = await api.get('/api/export/csv', {
    params: { scope: 'day', id: dayIds[0] },
  });
  console.log(`  GET /api/export/csv?scope=day&id=${dayIds[0]} → ${csvRes.status}`);
  const csvText = csvRes.data as string;
  const csvLines = csvText.split('\n');
  const headerLine = csvLines[0];
  console.log(`  Headers: ${headerLine}`);
  console.log(`  Data rows: ${csvLines.length - 1}`);

  assert('Status 200', csvRes.status === 200);
  assert('Content-Type is text/csv', (csvRes.headers['content-type'] as string).includes('text/csv'));
  assert('Has Content-Disposition', !!(csvRes.headers['content-disposition'] as string));

  // Validate CSV columns
  const expectedColumns = [
    'snapshot_id', 'timestamp', 'channel_identifier', 'display_name',
    'concurrent_viewers', 'platform', 'language', 'region', 'tier',
    'channel_id', 'broadcast_day_id', 'stage_id', 'series_id',
  ];
  const actualColumns = headerLine.split(',');
  assert('CSV has 13 columns', actualColumns.length === 13);
  for (const col of expectedColumns) {
    assert(`CSV column: ${col}`, actualColumns.includes(col));
  }
  assert('CSV has 2 data rows (2 snapshots)', csvLines.filter((l) => l.trim()).length - 1 === 2);

  // ═══════════════════════════════════════════════════════════════════
  // (l) GET /api/report-payload — Agent payload
  // ═══════════════════════════════════════════════════════════════════
  section('(l) GET /api/report-payload');
  const payloadRes = await api.get('/api/report-payload', {
    params: { scope: 'day', id: dayIds[0] },
  });
  console.log(`  GET /api/report-payload?scope=day&id=${dayIds[0]} → ${payloadRes.status}`);
  const payload = payloadRes.data;

  assert('Status 200', payloadRes.status === 200);
  assert('Has generatedAt', typeof payload.generatedAt === 'string');
  assert('Has scope', payload.scope === 'day');

  // Series info
  assert('Has series object', typeof payload.series === 'object');
  assert('series.name = PEC 2026', payload.series?.name === 'PEC 2026');
  assert('series.game = Counter-Strike', payload.series?.game === 'Counter-Strike');
  assert('series.partner = PGL', payload.series?.partner === 'PGL');

  // Stages
  assert('Has stages array', Array.isArray(payload.stages));
  assert('1 stage', payload.stages?.length === 1);
  assert('Stage name matches', payload.stages?.[0]?.name === 'Playoffs Weekend 1');

  // Broadcast days
  assert('Has broadcastDays array', Array.isArray(payload.broadcastDays));
  assert('1 broadcast day (scoped to day)', payload.broadcastDays?.length === 1);
  assert('Broadcast day label = Friday', payload.broadcastDays?.[0]?.label === 'Friday');

  // Channels
  assert('Has channels array', Array.isArray(payload.channels));
  assert('2 channels', payload.channels?.length === 2);

  // Snapshot count
  assert('Has snapshotCount', typeof payload.snapshotCount === 'number');
  assert('snapshotCount = 2', payload.snapshotCount === 2);

  // Metrics
  assert('Has metrics array', Array.isArray(payload.metrics));
  assert('1 metric entry (for 1 day)', payload.metrics?.length === 1);
  const dayMetric = payload.metrics?.[0];
  assert('Metric has peakCCV', typeof dayMetric?.peakCCV === 'number');
  assert('Metric has avgCCV', typeof dayMetric?.avgCCV === 'number');
  assert('Metric has totalViewedHours', typeof dayMetric?.totalViewedHours === 'number');
  assert('Metric has platformBreakdown', Array.isArray(dayMetric?.platformBreakdown));
  assert('Metric has languageBreakdown', Array.isArray(dayMetric?.languageBreakdown));
  assert('Metric has regionBreakdown', Array.isArray(dayMetric?.regionBreakdown));
  assert('Metric has channelLeaderboard', Array.isArray(dayMetric?.channelLeaderboard));

  console.log(`\n  Full payload structure:`);
  console.log(`    series:        ${payload.series?.name}`);
  console.log(`    stages:        ${payload.stages?.length} stage(s)`);
  console.log(`    broadcastDays: ${payload.broadcastDays?.length} day(s)`);
  console.log(`    channels:      ${payload.channels?.length} channel(s)`);
  console.log(`    snapshotCount: ${payload.snapshotCount}`);
  console.log(`    metrics:       ${payload.metrics?.length} day metric(s)`);

  // ═══════════════════════════════════════════════════════════════════
  // (m) GET /api/series/:id — Nested structure
  // ═══════════════════════════════════════════════════════════════════
  section('(m) GET /api/series/:id — Nested structure');
  const nestedRes = await api.get(`/api/series/${seriesId}`);
  console.log(`  GET /api/series/${seriesId} → ${nestedRes.status}`);
  assert('Status 200', nestedRes.status === 200);
  assert('Has stages array', Array.isArray(nestedRes.data.stages));
  assert('1 stage', nestedRes.data.stages?.length === 1);
  assert('Stage has broadcast_days', Array.isArray(nestedRes.data.stages?.[0]?.broadcast_days));
  assert('3 broadcast days under stage', nestedRes.data.stages?.[0]?.broadcast_days?.length === 3);

  // 404 test
  const notFound = await api.get('/api/series/00000000-0000-0000-0000-000000000000');
  assert('Nonexistent series → 404', notFound.status === 404);

  // ═══════════════════════════════════════════════════════════════════
  // (n) DELETE /api/series/:id — Cleanup
  // ═══════════════════════════════════════════════════════════════════
  section('(n) DELETE /api/series/:id — Cleanup');
  const deleteRes = await api.delete(`/api/series/${seriesId}`);
  console.log(`  DELETE /api/series/${seriesId} → ${deleteRes.status}`);
  assert('Status 204', deleteRes.status === 204);

  // Confirm cascade: series should be gone
  const goneRes = await api.get(`/api/series/${seriesId}`);
  assert('Series is gone (404)', goneRes.status === 404);

  // ═══════════════════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  section('SUMMARY');
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('\n💥 FATAL ERROR:', (err as AxiosError).message);
  process.exitCode = 1;
});
