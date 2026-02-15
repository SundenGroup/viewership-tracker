/**
 * End-to-end verification of the ReportAgent orchestrator.
 *
 * Runs 6 tests:
 *   1. Daily Recap PDF — generate for a single broadcast day
 *   2. Stage Report PDF — generate for a stage (multiple days)
 *   3. CSV Export — verify headers, row count, first 5 rows
 *   4. XLSX Export — confirm creation, expect multiple tabs
 *   5. Chart Generation — all applicable chart types, each > 5KB
 *   6. Narrative Generation — call Claude API (if key available)
 *
 * Prerequisites:
 *   - PostgreSQL running with clutch_viewership_test database
 *   - At least 50 snapshots seeded across multiple days/platforms/languages
 *
 * Usage: npx ts-node scripts/verify-agent.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { stat, readFile, readdir } from 'fs/promises';
import path from 'path';
import db from '../src/utils/db';
import { ReportAgent } from '../src/agent/report-agent';
import { ChartGenerator } from '../src/agent/chart-generator';
import * as ViewershipSnapshotModel from '../src/models/viewership-snapshot';
import * as BroadcastDayModel from '../src/models/broadcast-day';
import * as StageModel from '../src/models/stage';

// ── Test IDs ─────────────────────────────────────────────────────────────────

const SERIES_ID   = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const STAGE_ID    = 'a1000001-0000-0000-0000-000000000001'; // Group Stage
const DAY1_ID     = 'b1000001-0000-0000-0000-000000000001'; // Group Stage Day 1
const DAY2_ID     = 'b1000002-0000-0000-0000-000000000002'; // Group Stage Day 2

// ── Test Harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: Array<{ test: string; pass: boolean; detail: string }> = [];

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
    results.push({ test: label, pass: true, detail: detail ?? '' });
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    results.push({ test: label, pass: false, detail: detail ?? '' });
  }
}

function section(title: string) {
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(68));
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return -1;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Test 1: Daily Recap PDF ──────────────────────────────────────────────────

async function test1_DailyRecapPDF(): Promise<void> {
  section('Test 1 — Daily Recap PDF');

  const agent = new ReportAgent();
  const startTime = Date.now();

  try {
    const result = await agent.generateReport({
      scope: 'day',
      id: DAY1_ID,
      template: 'daily_recap',
      format: 'pdf',
      skipNarratives: true,
    });

    const elapsed = Date.now() - startTime;
    const size = await fileSize(result.filePath);

    console.log(`  File: ${result.filePath}`);
    console.log(`  Size: ${formatBytes(size)}`);
    console.log(`  Time: ${(elapsed / 1000).toFixed(1)}s`);

    assert('Daily recap PDF created', size > 0);
    assert('Daily recap PDF > 10KB', size > 10 * 1024, `actual: ${formatBytes(size)}`);
    assert('Result has correct scope', result.scope === 'day');
    assert('Result has series name', result.seriesName.length > 0, result.seriesName);
    assert('Result has filePath', result.filePath.endsWith('.pdf'));
  } catch (err) {
    assert('Daily recap PDF generation', false, (err as Error).message);
  }
}

// ── Test 2: Stage Report PDF ─────────────────────────────────────────────────

async function test2_StageReportPDF(): Promise<void> {
  section('Test 2 — Stage Report PDF');

  const agent = new ReportAgent();
  const startTime = Date.now();

  try {
    const result = await agent.generateReport({
      scope: 'stage',
      id: STAGE_ID,
      template: 'partner_full',
      format: 'pdf',
      skipNarratives: true,
    });

    const elapsed = Date.now() - startTime;
    const size = await fileSize(result.filePath);

    console.log(`  File: ${result.filePath}`);
    console.log(`  Size: ${formatBytes(size)}`);
    console.log(`  Time: ${(elapsed / 1000).toFixed(1)}s`);

    assert('Stage report PDF created', size > 0);
    assert('Stage report PDF > 10KB', size > 10 * 1024, `actual: ${formatBytes(size)}`);
    assert('Result scope is stage', result.scope === 'stage');

    // Stage report should include day-over-day chart and should be larger
    // than a single-day report (more data = more charts)
    assert('Stage report has reasonable size', size > 15 * 1024,
      `expected > 15KB for multi-day report, got ${formatBytes(size)}`);
  } catch (err) {
    assert('Stage report PDF generation', false, (err as Error).message);
  }
}

// ── Test 3: CSV Export ───────────────────────────────────────────────────────

async function test3_CSVExport(): Promise<void> {
  section('Test 3 — CSV Export');

  const agent = new ReportAgent();

  try {
    const result = await agent.generateExport({
      scope: 'series',
      id: SERIES_ID,
      format: 'csv',
    });

    const size = await fileSize(result.filePath);
    console.log(`  File: ${result.filePath}`);
    console.log(`  Size: ${formatBytes(size)}`);

    assert('CSV file created', size > 0);
    assert('CSV file path ends with .csv', result.filePath.endsWith('.csv'));

    // Read and verify CSV content
    const content = await readFile(result.filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const headerLine = lines[0] ?? '';
    const headers = headerLine.split(',');

    console.log(`  Headers: ${headerLine}`);
    console.log(`  Total rows (including header): ${lines.length}`);

    assert('CSV has header row', headers.length > 0);
    assert('CSV has expected columns', headers.includes('timestamp') || headers.includes('"timestamp"'),
      `found: ${headers.slice(0, 5).join(', ')}`);

    // Print first 5 data rows
    console.log('  First 5 data rows:');
    for (let i = 1; i <= Math.min(5, lines.length - 1); i++) {
      console.log(`    ${i}. ${lines[i]}`);
    }

    assert('CSV has data rows', lines.length > 1, `${lines.length - 1} data rows`);
    assert('CSV row count matches snapshots', lines.length - 1 >= 50,
      `expected >= 50 rows, got ${lines.length - 1}`);
  } catch (err) {
    assert('CSV export', false, (err as Error).message);
  }
}

// ── Test 4: XLSX Export ──────────────────────────────────────────────────────

async function test4_XLSXExport(): Promise<void> {
  section('Test 4 — XLSX Export');

  const agent = new ReportAgent();

  try {
    const result = await agent.generateExport({
      scope: 'series',
      id: SERIES_ID,
      format: 'xlsx',
    });

    const size = await fileSize(result.filePath);
    console.log(`  File: ${result.filePath}`);
    console.log(`  Size: ${formatBytes(size)}`);

    assert('XLSX file created', size > 0);
    assert('XLSX file path ends with .xlsx', result.filePath.endsWith('.xlsx'));
    assert('XLSX file > 5KB', size > 5 * 1024, `actual: ${formatBytes(size)}`);

    // XLSX is a ZIP archive — verify the PK header
    const header = Buffer.alloc(4);
    const fileHandle = await import('fs/promises').then(fs => fs.open(result.filePath, 'r'));
    await fileHandle.read(header, 0, 4, 0);
    await fileHandle.close();
    const isZip = header[0] === 0x50 && header[1] === 0x4b;
    assert('XLSX is valid ZIP archive', isZip, `header bytes: ${header.toString('hex')}`);

    // Use Python to verify tabs
    const { spawn } = await import('child_process');
    const verifyTabs = new Promise<string>((resolve, reject) => {
      const py = spawn('/usr/bin/python3', ['-c', `
import openpyxl, json, sys
wb = openpyxl.load_workbook('${result.filePath}', read_only=True)
sheets = wb.sheetnames
info = {"sheets": sheets, "sheet_count": len(sheets)}
for name in sheets:
    ws = wb[name]
    rows = sum(1 for _ in ws.rows)
    info[f"rows_{name}"] = rows
print(json.dumps(info))
      `]);
      let stdout = '';
      let stderr = '';
      py.stdout.on('data', (d: Buffer) => { stdout += d; });
      py.stderr.on('data', (d: Buffer) => { stderr += d; });
      py.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`Python exit ${code}: ${stderr}`));
      });
    });

    const tabInfo = JSON.parse(await verifyTabs);
    console.log(`  Sheets: ${(tabInfo.sheets as string[]).join(', ')}`);
    console.log(`  Sheet count: ${tabInfo.sheet_count}`);

    for (const name of tabInfo.sheets as string[]) {
      const rowKey = `rows_${name}`;
      console.log(`    "${name}" — ${tabInfo[rowKey]} rows`);
    }

    assert('XLSX has multiple tabs', (tabInfo.sheet_count as number) >= 2,
      `found ${tabInfo.sheet_count} tab(s)`);
  } catch (err) {
    assert('XLSX export', false, (err as Error).message);
  }
}

// ── Test 5: Chart Generation ─────────────────────────────────────────────────

async function test5_ChartGeneration(): Promise<void> {
  section('Test 5 — Chart Generation (all types)');

  // We need real data from the database for chart generation
  const gen = new ChartGenerator();

  try {
    // Fetch data for charts
    const dayScope: ViewershipSnapshotModel.Scope = { level: 'day', id: DAY1_ID };
    const [timeBuckets, platforms, languages, regions, leaderboard] = await Promise.all([
      ViewershipSnapshotModel.getTimeSeriesData(dayScope, 300),
      ViewershipSnapshotModel.getPlatformBreakdown(dayScope),
      ViewershipSnapshotModel.getLanguageBreakdown(dayScope),
      ViewershipSnapshotModel.getRegionBreakdown(dayScope),
      ViewershipSnapshotModel.getChannelLeaderboard(dayScope, 10),
    ]);

    console.log(`  Time series buckets: ${timeBuckets.length}`);
    console.log(`  Platforms: ${platforms.length}`);
    console.log(`  Languages: ${languages.length}`);
    console.log(`  Regions: ${regions.length}`);
    console.log(`  Leaderboard entries: ${leaderboard.length}`);

    // Prepare typed data
    const timeSeriesData = timeBuckets.map((b) => ({
      timestamp: new Date(b.bucket).toISOString(),
      totalCCV: parseInt(b.total_ccv, 10),
      channelCount: parseInt(b.channel_count, 10),
    }));

    const platformData = platforms.map((p) => ({
      platform: p.key,
      totalCCV: parseInt(p.total_ccv, 10),
      avgCCV: parseFloat(p.avg_ccv),
      peakCCV: parseInt(p.peak_ccv, 10),
    }));

    const languageData = languages.map((l) => ({
      language: l.key,
      totalCCV: parseInt(l.total_ccv, 10),
      avgCCV: parseFloat(l.avg_ccv),
      peakCCV: parseInt(l.peak_ccv, 10),
    }));

    const regionData = regions.map((r) => ({
      region: r.key,
      totalCCV: parseInt(r.total_ccv, 10),
      avgCCV: parseFloat(r.avg_ccv),
      peakCCV: parseInt(r.peak_ccv, 10),
    }));

    const leaderboardData = leaderboard.map((e) => ({
      channelId: e.channel_id,
      displayName: e.display_name,
      platform: e.platform,
      peakCCV: parseInt(e.peak_ccv, 10),
      avgCCV: parseFloat(e.avg_ccv),
      totalViewedMinutes: 0,
    }));

    // Get day metrics for both days in Group Stage
    const day1Metrics = {
      dayLabel: 'Day 1',
      date: '2026-03-15',
      peakCCV: timeSeriesData.reduce((max, p) => Math.max(max, p.totalCCV), 0),
      avgCCV: Math.round(timeSeriesData.reduce((sum, p) => sum + p.totalCCV, 0) / Math.max(timeSeriesData.length, 1)),
      totalViewedHours: 150,
    };

    const day2Scope: ViewershipSnapshotModel.Scope = { level: 'day', id: DAY2_ID };
    const day2Buckets = await ViewershipSnapshotModel.getTimeSeriesData(day2Scope, 300);
    const day2TS = day2Buckets.map(b => ({
      timestamp: new Date(b.bucket).toISOString(),
      totalCCV: parseInt(b.total_ccv, 10),
      channelCount: parseInt(b.channel_count, 10),
    }));

    const day2Metrics = {
      dayLabel: 'Day 2',
      date: '2026-03-16',
      peakCCV: day2TS.reduce((max, p) => Math.max(max, p.totalCCV), 0),
      avgCCV: Math.round(day2TS.reduce((sum, p) => sum + p.totalCCV, 0) / Math.max(day2TS.length, 1)),
      totalViewedHours: 120,
    };

    // Generate all charts
    const chartNames: string[] = [];
    const chartPromises: Array<Promise<string>> = [];

    // 1. Time Series
    if (timeSeriesData.length > 0) {
      chartNames.push('Time Series');
      chartPromises.push(gen.generateTimeSeriesChart(timeSeriesData, { title: 'Viewership Timeline' }));
    }

    // 2. Platform Donut
    if (platformData.length > 0) {
      chartNames.push('Platform Donut');
      chartPromises.push(gen.generatePlatformDonut(platformData, { title: 'Platform Distribution' }));
    }

    // 3. Language Bars
    if (languageData.length > 0) {
      chartNames.push('Language Bars');
      chartPromises.push(gen.generateLanguageBars(languageData, { title: 'Language Distribution' }));
    }

    // 4. Region Bars
    if (regionData.length > 0) {
      chartNames.push('Region Bars');
      chartPromises.push(gen.generateRegionBars(regionData, { title: 'Region Distribution' }));
    }

    // 5. Channel Leaderboard
    if (leaderboardData.length > 0) {
      chartNames.push('Channel Leaderboard');
      chartPromises.push(gen.generateChannelLeaderboard(leaderboardData, { title: 'Top Channels' }));
    }

    // 6. Day-over-Day
    chartNames.push('Day-over-Day');
    chartPromises.push(gen.generateDayOverDayTrend([day1Metrics, day2Metrics], { title: 'Day-over-Day' }));

    // 7. Stage Comparison (mock 2 stages)
    chartNames.push('Stage Comparison');
    chartPromises.push(gen.generateStageComparison([
      { stageName: 'Group Stage', peakCCV: 45000, avgCCV: 22000, totalViewedHours: 300, channelCount: 12 },
      { stageName: 'Grand Finals', peakCCV: 78000, avgCCV: 41000, totalViewedHours: 150, channelCount: 12 },
    ], { title: 'Stage Comparison' }));

    // 8. Stacked Area by Language (need grouped data)
    if (timeSeriesData.length > 0 && languageData.length > 0) {
      const groupedLang = timeSeriesData.flatMap((pt) =>
        languageData.slice(0, 3).map((l, i) => ({
          timestamp: pt.timestamp,
          groupKey: l.language,
          totalCCV: Math.round(pt.totalCCV * (0.5 - i * 0.15)),
          channelCount: Math.max(1, Math.round(pt.channelCount / 3)),
        })),
      );
      chartNames.push('Stacked Area (Language)');
      chartPromises.push(gen.generateStackedAreaByLanguage(groupedLang, { title: 'CCV by Language' }));
    }

    // 9. Stacked Area by Region (need grouped data)
    if (timeSeriesData.length > 0 && regionData.length > 0) {
      const groupedRegion = timeSeriesData.flatMap((pt) =>
        regionData.slice(0, 2).map((r, i) => ({
          timestamp: pt.timestamp,
          groupKey: r.region,
          totalCCV: Math.round(pt.totalCCV * (0.6 - i * 0.3)),
          channelCount: Math.max(1, Math.round(pt.channelCount / 2)),
        })),
      );
      chartNames.push('Stacked Area (Region)');
      chartPromises.push(gen.generateStackedAreaByRegion(groupedRegion, { title: 'CCV by Region' }));
    }

    console.log(`\n  Generating ${chartPromises.length} charts in parallel...`);
    const startTime = Date.now();
    const chartPaths = await Promise.all(chartPromises);
    const elapsed = Date.now() - startTime;
    console.log(`  All charts generated in ${(elapsed / 1000).toFixed(1)}s\n`);

    // Verify each chart
    let allChartsAbove5KB = true;
    for (let i = 0; i < chartPaths.length; i++) {
      const chartPath = chartPaths[i] as string;
      const chartName = chartNames[i] as string;
      const size = await fileSize(chartPath);

      const above5KB = size > 5 * 1024;
      if (!above5KB) allChartsAbove5KB = false;

      console.log(`  ${above5KB ? '✅' : '❌'} ${chartName}: ${formatBytes(size)} → ${chartPath}`);
    }

    assert(`All ${chartPaths.length} chart types generated`, chartPaths.length >= 7,
      `generated ${chartPaths.length} charts`);
    assert('All charts > 5KB', allChartsAbove5KB);

    // Cleanup
    await gen.cleanup();
  } catch (err) {
    assert('Chart generation', false, (err as Error).message);
  }
}

// ── Test 6: Narrative Generation ─────────────────────────────────────────────

async function test6_NarrativeGeneration(): Promise<void> {
  section('Test 6 — Narrative Generation (Claude API)');

  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  if (!hasKey) {
    console.log('  ⚠️  ANTHROPIC_API_KEY not set — testing fallback behavior');
    const agent = new ReportAgent();

    // Without API key, narratives should be empty but not crash
    try {
      const result = await agent.generateReport({
        scope: 'day',
        id: DAY1_ID,
        template: 'daily_recap',
        format: 'pdf',
        skipNarratives: false, // don't skip, but no key → graceful fallback
      });

      assert('Report generates without API key (graceful fallback)', result.filePath.endsWith('.pdf'));
      assert('Report scope correct', result.scope === 'day');

      console.log('  ℹ️  To test actual narrative generation, set ANTHROPIC_API_KEY in .env');
    } catch (err) {
      assert('Graceful fallback without API key', false, (err as Error).message);
    }

    return;
  }

  // Full narrative test with API key
  const agent = new ReportAgent();

  try {
    const result = await agent.generateReport({
      scope: 'day',
      id: DAY1_ID,
      template: 'daily_recap',
      format: 'pdf',
      skipNarratives: false,
    });

    const size = await fileSize(result.filePath);
    console.log(`  File: ${result.filePath}`);
    console.log(`  Size: ${formatBytes(size)} (should be larger than skipNarratives version)`);

    assert('PDF with narratives created', size > 0);
    assert('PDF with narratives > 10KB', size > 10 * 1024, `actual: ${formatBytes(size)}`);
    assert('Report includes series name', result.seriesName.includes('PUBG') || result.seriesName.includes('PEC'),
      result.seriesName);

    // The narrative-included PDF should ideally be larger than the no-narrative version
    // since it has additional text sections
    assert('Narrative PDF has reasonable size', size > 15 * 1024,
      `expected > 15KB with narratives, got ${formatBytes(size)}`);
  } catch (err) {
    assert('Narrative generation', false, (err as Error).message);
  }
}

// ── Main Runner ──────────────────────────────────────────────────────────────

async function run() {
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║        ReportAgent End-to-End Verification                        ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');

  // Pre-flight checks
  section('Pre-flight Checks');

  const snapshotCount = await db('viewership_snapshots').count('* as count').first();
  const count = parseInt((snapshotCount as { count: string })?.count ?? '0', 10);
  console.log(`  Snapshots in database: ${count}`);
  assert('Sufficient test data', count >= 50, `found ${count} snapshots`);

  const stages = await StageModel.findAll({ series_id: SERIES_ID });
  console.log(`  Stages: ${stages.length}`);
  assert('Test series has stages', stages.length >= 2, `found ${stages.length}`);

  const days = await BroadcastDayModel.findAll({ series_id: SERIES_ID });
  console.log(`  Broadcast days: ${days.length}`);
  assert('Test series has broadcast days', days.length >= 2, `found ${days.length}`);

  // Run all tests sequentially
  await test1_DailyRecapPDF();
  await test2_StageReportPDF();
  await test3_CSVExport();
  await test4_XLSXExport();
  await test5_ChartGeneration();
  await test6_NarrativeGeneration();

  // ── Summary ──────────────────────────────────────────────────────────
  section('Summary');
  console.log(`  Total: ${passed + failed}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Pass rate: ${((passed / (passed + failed)) * 100).toFixed(0)}%\n`);

  if (failed > 0) {
    console.log('  Failed tests:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`    ❌ ${r.test}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }

  // List generated report files
  section('Generated Files');
  const reportsDir = path.resolve(process.cwd(), 'reports');
  try {
    const seriesFolders = await readdir(reportsDir);
    for (const folder of seriesFolders) {
      const folderPath = path.join(reportsDir, folder);
      const folderStat = await stat(folderPath).catch(() => null);
      if (!folderStat?.isDirectory()) continue;

      const files = await readdir(folderPath);
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        const size = await fileSize(filePath);
        console.log(`  📄 ${folder}/${file} — ${formatBytes(size)}`);
      }
    }
  } catch {
    console.log('  (no reports directory)');
  }

  console.log('');

  await db.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  db.destroy().then(() => process.exit(2));
});
