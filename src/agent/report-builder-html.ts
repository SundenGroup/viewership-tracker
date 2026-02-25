/**
 * HTML Report Builder
 *
 * Generates self-contained interactive HTML viewership reports using Chart.js.
 * Reports feature:
 *   - Clutch dark-themed dashboard layout
 *   - Interactive doughnut charts (platform, language, category)
 *   - Stacked area timeline chart (per-platform CCV)
 *   - Sortable streamer breakdown table
 *   - Print stylesheet for clean PDF export via Cmd+P
 *
 * No Python dependency — pure TypeScript template literals.
 */

import type { ReportPayload, Narratives } from './report-builder';
import type {
  PlatformBreakdown,
  LanguageBreakdown,
  ChannelLeaderboardEntry,
  TimeSeriesPoint,
  GroupedTimeSeriesPoint,
} from './chart-generator';

// ── Types ───────────────────────────────────────────────────────────────────

export interface HTMLReportData {
  payload: ReportPayload;
  totalTimeSeries: TimeSeriesPoint[];
  platformTimeSeries: GroupedTimeSeriesPoint[];
  aggregated: {
    peakCCV: number;
    avgCCV: number;
    totalViewedHours: number;
    platformBreakdown: PlatformBreakdown[];
    languageBreakdown: LanguageBreakdown[];
    channelLeaderboard: ChannelLeaderboardEntry[];
  };
  narratives: Narratives;
}

// ── Platform / Language / Tier Colors ────────────────────────────────────────

const PLATFORM_COLORS: Record<string, string> = {
  twitch: '#9146ff',
  youtube: '#ff0033',
  kick: '#53fc18',
  tiktok: '#fe2c55',
};

const PLATFORM_COLORS_ALPHA: Record<string, string> = {
  twitch: 'rgba(145,70,255,0.12)',
  youtube: 'rgba(255,0,51,0.12)',
  kick: 'rgba(83,252,24,0.12)',
  tiktok: 'rgba(254,44,85,0.12)',
};

const LANGUAGE_COLORS: string[] = [
  '#4fc3f7', '#ffb74d', '#ef5350', '#66bb6a',
  '#ba68c8', '#ff8a65', '#4dd0e1', '#fff176',
];

const TIER_CLASSES: Record<string, { tag: string; label: string }> = {
  official: { tag: 'tag-official', label: 'Official' },
  partner: { tag: 'tag-partner', label: 'Partner' },
  primary: { tag: 'tag-primary', label: 'Primary' },
  community: { tag: 'tag-community', label: 'Community' },
  watchparty: { tag: 'tag-watchparty', label: 'Watch Party' },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtDecimal(n: number, digits = 1): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function tierLabel(tier: string | null | undefined): string {
  if (!tier) return 'Community';
  return TIER_CLASSES[tier]?.label ?? capitalize(tier);
}

function tierTagClass(tier: string | null | undefined): string {
  if (!tier) return 'tag-community';
  return TIER_CLASSES[tier]?.tag ?? 'tag-community';
}

function platformColor(platform: string): string {
  return PLATFORM_COLORS[platform.toLowerCase()] ?? '#7a82a0';
}

function langColor(index: number): string {
  return LANGUAGE_COLORS[index % LANGUAGE_COLORS.length];
}

function formatTimeHHMM(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toISOString().slice(11, 16);
}

// ── Main Export ─────────────────────────────────────────────────────────────

export function buildHTMLReport(data: HTMLReportData): string {
  const { payload, totalTimeSeries, platformTimeSeries, aggregated, narratives } = data;

  const seriesName = esc(payload.series.name);
  const scope = payload.scope;

  // Build header subtitle
  const days = payload.broadcastDays;
  let subtitle = '';
  if (scope === 'day' && days.length === 1) {
    const day = days[0];
    const dateStr = day.date;
    const start = day.broadcastStart ? formatTimeHHMM(day.broadcastStart) : '';
    const end = day.broadcastEnd ? formatTimeHHMM(day.broadcastEnd) : '';
    const timeRange = start && end ? `${start} \u2013 ${end} UTC` : '';
    subtitle = [dateStr, timeRange, `${payload.channels.length} Streamers`]
      .filter(Boolean)
      .join(' &nbsp;\u00b7&nbsp; ');
  } else {
    const dayCount = days.length;
    const stageCount = payload.stages.length;
    subtitle = [
      stageCount > 0 ? `${stageCount} Stage${stageCount > 1 ? 's' : ''}` : '',
      `${dayCount} Day${dayCount > 1 ? 's' : ''}`,
      `${payload.channels.length} Streamers`,
    ]
      .filter(Boolean)
      .join(' &nbsp;\u00b7&nbsp; ');
  }

  // Scope label for title
  const scopeTitle = scope === 'day' ? 'Day Report' :
    scope === 'stage' ? 'Stage Report' :
    scope === 'series' ? 'Series Report' : 'Report';

  // Prepare chart data as JSON for embedding
  const platformNames = [...new Set(platformTimeSeries.map((p) => p.groupKey?.toLowerCase()).filter(Boolean))];

  // Build per-platform time series arrays
  const timeLabels = totalTimeSeries.map((p) => formatTimeHHMM(p.timestamp));
  const totalCCVArray = totalTimeSeries.map((p) => p.totalCCV);

  // Map grouped data to per-platform arrays aligned with timeLabels
  const timestampIndex = new Map<string, number>();
  totalTimeSeries.forEach((p, i) => timestampIndex.set(p.timestamp, i));

  const platformTSData: Record<string, number[]> = {};
  for (const name of platformNames) {
    platformTSData[name] = new Array(totalTimeSeries.length).fill(0);
  }
  for (const pt of platformTimeSeries) {
    const key = pt.groupKey?.toLowerCase();
    if (!key || !platformTSData[key]) continue;
    const idx = timestampIndex.get(pt.timestamp);
    if (idx !== undefined) {
      platformTSData[key][idx] = pt.totalCCV;
    }
  }

  // Platform breakdown for pie chart
  const platLabels = aggregated.platformBreakdown.map((p) => capitalize(p.platform));
  const platVH = aggregated.platformBreakdown.map((p) => {
    // Compute viewed hours from totalCCV (which is really sum of per-minute viewers)
    return Math.round(p.totalCCV / 60);
  });
  const platColors = aggregated.platformBreakdown.map((p) => platformColor(p.platform));

  // Language breakdown for pie chart
  const langLabels = aggregated.languageBreakdown.map((l) => capitalize(l.language || 'Unknown'));
  const langVH = aggregated.languageBreakdown.map((l) => Math.round(l.totalCCV / 60));
  const langColors = aggregated.languageBreakdown.map((_, i) => langColor(i));

  // Tier/category breakdown: aggregate from channels + leaderboard
  const tierMap = new Map<string, { totalCCV: number; avgCCV: number; peakCCV: number }>();
  for (const ch of aggregated.channelLeaderboard) {
    const channel = payload.channels.find((c) => c.id === ch.channelId);
    const tier = channel?.tier ?? 'community';
    const existing = tierMap.get(tier);
    if (existing) {
      existing.totalCCV += ch.totalViewedMinutes ?? 0;
      existing.avgCCV += ch.avgCCV;
      existing.peakCCV = Math.max(existing.peakCCV, ch.peakCCV);
    } else {
      tierMap.set(tier, {
        totalCCV: ch.totalViewedMinutes ?? 0,
        avgCCV: ch.avgCCV,
        peakCCV: ch.peakCCV,
      });
    }
  }
  const tierEntries = [...tierMap.entries()].sort((a, b) => b[1].totalCCV - a[1].totalCCV);
  const tierLabels = tierEntries.map(([t]) => tierLabel(t));
  const tierVH = tierEntries.map(([, v]) => Math.round(v.totalCCV / 60));
  const TIER_COLORS: Record<string, string> = {
    official: '#FF154D',
    partner: '#f0c040',
    primary: '#f0c040',
    community: '#26c6da',
    watchparty: '#7c4dff',
  };
  const tierColors = tierEntries.map(([t]) => TIER_COLORS[t] ?? '#7a82a0');

  // Streamer stats for sortable table
  const streamerStats = aggregated.channelLeaderboard.map((ch) => {
    const channel = payload.channels.find((c) => c.id === ch.channelId);
    return {
      name: ch.displayName,
      platform: ch.platform.toLowerCase(),
      tier: tierLabel(channel?.tier),
      lang: capitalize(channel?.language ?? 'Unknown'),
      avg: Math.round(ch.avgCCV),
      peak: ch.peakCCV,
      vh: Math.round((ch.totalViewedMinutes ?? 0) / 60),
    };
  });

  // Breakdown tables data
  const platTableRows = aggregated.platformBreakdown.map((p) => ({
    label: capitalize(p.platform),
    dotClass: `dot-${p.platform.toLowerCase()}`,
    vh: fmtNum(Math.round(p.totalCCV / 60)),
    avg: fmtNum(Math.round(p.avgCCV)),
    peak: fmtNum(p.peakCCV),
  }));

  const langTableRows = aggregated.languageBreakdown.map((l, i) => ({
    label: capitalize(l.language || 'Unknown'),
    colorIdx: i,
    vh: fmtNum(Math.round(l.totalCCV / 60)),
    avg: fmtNum(Math.round(l.avgCCV)),
    peak: fmtNum(l.peakCCV),
  }));

  const tierTableRows = tierEntries.map(([tier, v]) => ({
    label: tierLabel(tier),
    tierClass: tierTagClass(tier),
    vh: fmtNum(Math.round(v.totalCCV / 60)),
    avg: fmtNum(Math.round(v.avgCCV)),
    peak: fmtNum(v.peakCCV),
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${seriesName} — ${esc(scopeTitle)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0c0e14;
    --card: #141722;
    --card-border: #1e2336;
    --text: #e4e7ef;
    --text-muted: #7a82a0;
    --accent-red: #FF154D;
    --accent-twitch: #9146ff;
    --accent-kick: #53fc18;
    --accent-youtube: #ff0033;
    --accent-tiktok: #fe2c55;
    --highlight: #FF154D;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { overflow-x: hidden; }

  body {
    font-family: 'DM Sans', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 32px 24px 64px;
    overflow-x: hidden;
  }

  .container { max-width: 1120px; margin: 0 auto; }

  header {
    text-align: center;
    margin-bottom: 48px;
    position: relative;
  }
  header::after {
    content: '';
    position: absolute;
    bottom: -20px;
    left: 50%;
    transform: translateX(-50%);
    width: 80px;
    height: 3px;
    background: var(--accent-red);
    border-radius: 2px;
  }
  header h1 {
    font-family: 'Space Mono', monospace;
    font-size: 28px;
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, #fff 0%, #a0a8c8 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 6px;
  }
  header p {
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 500;
  }
  .powered-by {
    margin-top: 8px;
    font-size: 11px;
    color: #4a5070;
    letter-spacing: 0.5px;
  }

  .kpi-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 32px;
  }
  .kpi {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 14px;
    padding: 24px 20px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .kpi::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: var(--accent-red);
  }
  .kpi-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    font-weight: 600;
  }
  .kpi-value {
    font-family: 'Space Mono', monospace;
    font-size: 32px;
    font-weight: 700;
    color: #fff;
  }

  .section-title {
    font-family: 'Space Mono', monospace;
    font-size: 15px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
    margin-bottom: 16px;
    padding-left: 4px;
  }

  .narrative {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 14px;
    padding: 20px 24px;
    margin-bottom: 32px;
    color: var(--text);
    font-size: 14px;
    line-height: 1.6;
  }

  .charts-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 32px;
  }
  .chart-card {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 14px;
    padding: 24px;
  }
  .chart-card h3 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 16px;
    color: var(--text);
  }
  .chart-card.full {
    grid-column: 1 / -1;
  }

  .table-card {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 14px;
    padding: 24px;
    margin-bottom: 24px;
    overflow-x: auto;
  }
  .table-card h3 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 16px;
  }

  .tables-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 32px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    text-align: left;
    font-weight: 600;
    color: var(--text-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--card-border);
  }
  th:not(:first-child) { text-align: right; }
  td {
    padding: 12px 14px;
    border-bottom: 1px solid rgba(30, 35, 54, 0.5);
    font-weight: 500;
  }
  td:not(:first-child) {
    text-align: right;
    font-family: 'Space Mono', monospace;
    font-size: 12px;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,0.02); }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .dot-twitch { background: var(--accent-twitch); box-shadow: 0 0 6px rgba(145,70,255,0.4); }
  .dot-kick { background: var(--accent-kick); box-shadow: 0 0 6px rgba(83,252,24,0.4); }
  .dot-youtube { background: var(--accent-youtube); box-shadow: 0 0 6px rgba(255,0,51,0.4); }
  .dot-tiktok { background: var(--accent-tiktok); box-shadow: 0 0 6px rgba(254,44,85,0.4); }

  .total-row td {
    font-weight: 700;
    color: var(--highlight);
    border-top: 2px solid var(--card-border);
    border-bottom: none;
  }

  .pie-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
  }
  .pie-canvas-wrap { width: 100%; max-width: 180px; }
  .pie-legend { width: 100%; }
  .pie-legend-item {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .pie-legend-color {
    width: 12px; height: 12px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .pie-legend-label { font-size: 13px; font-weight: 500; }
  .pie-legend-value {
    font-family: 'Space Mono', monospace;
    font-size: 12px;
    color: var(--text-muted);
    margin-left: auto;
  }

  .tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
    font-family: 'DM Sans', sans-serif;
  }
  .tag-official { background: rgba(255,21,77,0.15); color: #FF154D; }
  .tag-partner { background: rgba(240,192,64,0.15); color: #f0c040; }
  .tag-primary { background: rgba(240,192,64,0.15); color: #f0c040; }
  .tag-watchparty { background: rgba(124,77,255,0.15); color: #b388ff; }
  .tag-community { background: rgba(38,198,218,0.15); color: #26c6da; }

  /* Sortable table */
  .sortable-th {
    cursor: pointer;
    user-select: none;
    position: relative;
    transition: color 0.2s;
  }
  .sortable-th:hover { color: #c0c6e0; }
  .sortable-th .sort-icon {
    display: inline-block;
    margin-left: 4px;
    font-size: 10px;
    opacity: 0.3;
    transition: opacity 0.2s;
    vertical-align: middle;
  }
  .sortable-th.asc .sort-icon,
  .sortable-th.desc .sort-icon {
    opacity: 1;
    color: var(--highlight);
  }
  .sortable-th.asc .sort-icon::after { content: '\\25B2'; }
  .sortable-th.desc .sort-icon::after { content: '\\25BC'; }
  .sortable-th:not(.asc):not(.desc) .sort-icon::after { content: '\\21C5'; }

  footer {
    text-align: center;
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid var(--card-border);
    color: #4a5070;
    font-size: 11px;
  }

  @media (max-width: 900px) {
    .kpi-row, .charts-row, .tables-grid { grid-template-columns: 1fr; }
  }

  @media print {
    body {
      background: #fff;
      color: #1a1a1a;
      padding: 0;
      font-size: 11px;
    }
    .container { max-width: 100%; }
    header::after { background: #FF154D; }
    header h1 {
      background: none;
      -webkit-text-fill-color: #1a1a1a;
      color: #1a1a1a;
    }
    header p { color: #666; }
    .kpi {
      background: #f8f8f8;
      border-color: #ddd;
    }
    .kpi::before { background: #FF154D; }
    .kpi-label { color: #666; }
    .kpi-value { color: #1a1a1a; }
    .chart-card, .table-card, .narrative {
      background: #fff;
      border-color: #ddd;
      break-inside: avoid;
    }
    .narrative { color: #333; }
    th { color: #666; border-color: #ddd; }
    td { border-color: #eee; color: #333; }
    .total-row td { color: #FF154D; border-color: #ddd; }
    .section-title { color: #666; }
    .dot { box-shadow: none; }
    footer { color: #999; border-color: #ddd; }
    @page { size: A4; margin: 2cm; }
  }
</style>
</head>
<body>
<div class="container">

  <header>
    <img src="/assets/clutch-logo-white.png" alt="Clutch" style="height:40px;margin-bottom:16px;opacity:0.9;">
    <h1>${seriesName} \u2014 ${esc(scopeTitle)}</h1>
    <p>${subtitle}</p>
  </header>

  <!-- KPIs -->
  <div class="kpi-row">
    <div class="kpi">
      <div class="kpi-label">Total Viewed Hours</div>
      <div class="kpi-value">${fmtNum(Math.round(aggregated.totalViewedHours))}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Avg Concurrent</div>
      <div class="kpi-value">${fmtNum(aggregated.avgCCV)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Peak Concurrent</div>
      <div class="kpi-value">${fmtNum(aggregated.peakCCV)}</div>
    </div>
  </div>

${narratives.executive_summary ? `
  <!-- Executive Summary -->
  <div class="section-title">Executive Summary</div>
  <div class="narrative">${esc(narratives.executive_summary)}</div>
` : ''}

  <!-- 3 Pie Charts -->
  <div class="charts-row">
    <div class="chart-card">
      <h3>Viewed Hours by Platform</h3>
      <div class="pie-wrapper">
        <div class="pie-canvas-wrap"><canvas id="piePlatform"></canvas></div>
        <div class="pie-legend" id="legendPlatform"></div>
      </div>
    </div>
    <div class="chart-card">
      <h3>Viewed Hours by Language</h3>
      <div class="pie-wrapper">
        <div class="pie-canvas-wrap"><canvas id="pieLang"></canvas></div>
        <div class="pie-legend" id="legendLang"></div>
      </div>
    </div>
    <div class="chart-card">
      <h3>Viewed Hours by Category</h3>
      <div class="pie-wrapper">
        <div class="pie-canvas-wrap"><canvas id="pieCat"></canvas></div>
        <div class="pie-legend" id="legendCat"></div>
      </div>
    </div>
  </div>

  <!-- 3 Breakdown Tables -->
  <div class="tables-grid">
    <div class="table-card">
      <h3>Platform Breakdown</h3>
      <table>
        <thead><tr><th>Platform</th><th>VH</th><th>Avg</th><th>Peak</th></tr></thead>
        <tbody>
${platTableRows.map((r) => `          <tr>
            <td><span class="badge"><span class="dot ${esc(r.dotClass)}"></span>${esc(r.label)}</span></td>
            <td>${r.vh}</td><td>${r.avg}</td><td>${r.peak}</td>
          </tr>`).join('\n')}
          <tr class="total-row">
            <td>Total</td>
            <td>${fmtNum(Math.round(aggregated.totalViewedHours))}</td>
            <td>${fmtNum(aggregated.avgCCV)}</td>
            <td>${fmtNum(aggregated.peakCCV)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="table-card">
      <h3>Language Breakdown</h3>
      <table>
        <thead><tr><th>Language</th><th>VH</th><th>Avg</th><th>Peak</th></tr></thead>
        <tbody>
${langTableRows.map((r) => `          <tr>
            <td><span class="badge"><span class="dot" style="background:${langColor(r.colorIdx)};box-shadow:0 0 6px ${langColor(r.colorIdx)}40"></span>${esc(r.label)}</span></td>
            <td>${r.vh}</td><td>${r.avg}</td><td>${r.peak}</td>
          </tr>`).join('\n')}
          <tr class="total-row">
            <td>Total</td>
            <td>${fmtNum(Math.round(aggregated.totalViewedHours))}</td>
            <td>${fmtNum(aggregated.avgCCV)}</td>
            <td>${fmtNum(aggregated.peakCCV)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="table-card">
      <h3>Category Breakdown</h3>
      <table>
        <thead><tr><th>Category</th><th>VH</th><th>Avg</th><th>Peak</th></tr></thead>
        <tbody>
${tierTableRows.map((r) => `          <tr>
            <td><span class="tag ${esc(r.tierClass)}">${esc(r.label)}</span></td>
            <td>${r.vh}</td><td>${r.avg}</td><td>${r.peak}</td>
          </tr>`).join('\n')}
          <tr class="total-row">
            <td>Total</td>
            <td>${fmtNum(Math.round(aggregated.totalViewedHours))}</td>
            <td>${fmtNum(aggregated.avgCCV)}</td>
            <td>${fmtNum(aggregated.peakCCV)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Concurrent Line Chart -->
  <div class="chart-card full" style="margin-bottom:32px;">
    <h3>Concurrent Viewers Over Time</h3>
    <canvas id="lineChart" height="110"></canvas>
  </div>

${narratives.viewership_timeline ? `
  <div class="narrative">${esc(narratives.viewership_timeline)}</div>
` : ''}

  <!-- Streamer Table -->
  <div class="section-title">Streamer Breakdown</div>
  <div class="table-card">
    <table>
      <thead>
        <tr>
          <th class="sortable-th" data-key="name" data-type="string">Streamer<span class="sort-icon"></span></th>
          <th class="sortable-th" data-key="platform" data-type="string" style="text-align:center">Platform<span class="sort-icon"></span></th>
          <th class="sortable-th" data-key="tier" data-type="string" style="text-align:center">Category<span class="sort-icon"></span></th>
          <th class="sortable-th" data-key="lang" data-type="string" style="text-align:center">Language<span class="sort-icon"></span></th>
          <th class="sortable-th desc" data-key="avg" data-type="number">Avg CCU<span class="sort-icon"></span></th>
          <th class="sortable-th" data-key="peak" data-type="number">Peak CCU<span class="sort-icon"></span></th>
          <th class="sortable-th" data-key="vh" data-type="number">Viewed Hours<span class="sort-icon"></span></th>
        </tr>
      </thead>
      <tbody id="streamerBody"></tbody>
    </table>
  </div>

${narratives.platform_analysis ? `
  <div class="section-title">Platform Analysis</div>
  <div class="narrative">${esc(narratives.platform_analysis)}</div>
` : ''}

${narratives.audience_breakdown ? `
  <div class="section-title">Audience Breakdown</div>
  <div class="narrative">${esc(narratives.audience_breakdown)}</div>
` : ''}

${narratives.community_reach ? `
  <div class="section-title">Community Reach</div>
  <div class="narrative">${esc(narratives.community_reach)}</div>
` : ''}

${narratives.day_over_day ? `
  <div class="section-title">Day-over-Day</div>
  <div class="narrative">${esc(narratives.day_over_day)}</div>
` : ''}

${narratives.stage_comparison ? `
  <div class="section-title">Stage Comparison</div>
  <div class="narrative">${esc(narratives.stage_comparison)}</div>
` : ''}

  <footer>
    Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC &mdash; Clutch Viewership Tracker
  </footer>

</div>

<script>
// ── Embedded Data ──
const C = ${JSON.stringify(Object.fromEntries(Object.entries(PLATFORM_COLORS).filter(([k]) => platformNames.includes(k))))};
const CA = ${JSON.stringify(Object.fromEntries(Object.entries(PLATFORM_COLORS_ALPHA).filter(([k]) => platformNames.includes(k))))};

const streamerStats = ${JSON.stringify(streamerStats)};
const timeLabels = ${JSON.stringify(timeLabels)};
const totalTS = ${JSON.stringify(totalCCVArray)};
const platformTS = ${JSON.stringify(platformTSData)};

const tierClasses = ${JSON.stringify(Object.fromEntries(
  Object.entries(TIER_CLASSES).map(([, v]) => [v.label, v.tag])
))};

// ── Chart defaults ──
Chart.defaults.color = '#7a82a0';
Chart.defaults.font.family = "'DM Sans', sans-serif";
Chart.defaults.font.size = 11;

// ── Pie builder ──
function buildPie(canvasId, legendId, labels, data, colors) {
  var total = data.reduce(function(a,b){return a+b}, 0);
  if (total === 0) return;
  new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: colors,
        borderColor: '#141722',
        borderWidth: 3,
        hoverOffset: 6
      }]
    },
    options: {
      cutout: '60%',
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      animation: { animateRotate: true, duration: 900 }
    }
  });
  var leg = document.getElementById(legendId);
  labels.forEach(function(l, i) {
    var pct = ((data[i]/total)*100).toFixed(1);
    leg.innerHTML += '<div class="pie-legend-item">' +
      '<div class="pie-legend-color" style="background:' + colors[i] + '"></div>' +
      '<span class="pie-legend-label">' + l + '</span>' +
      '<span class="pie-legend-value">' + pct + '%</span>' +
    '</div>';
  });
}

buildPie('piePlatform', 'legendPlatform',
  ${JSON.stringify(platLabels)},
  ${JSON.stringify(platVH)},
  ${JSON.stringify(platColors)}
);

buildPie('pieLang', 'legendLang',
  ${JSON.stringify(langLabels)},
  ${JSON.stringify(langVH)},
  ${JSON.stringify(langColors)}
);

buildPie('pieCat', 'legendCat',
  ${JSON.stringify(tierLabels)},
  ${JSON.stringify(tierVH)},
  ${JSON.stringify(tierColors)}
);

// ── Line Chart ──
var sparseLabels = timeLabels.map(function(l, i) { return i % 12 === 0 ? l : ''; });

var lineDatasets = [
  {
    label: 'Total',
    data: totalTS,
    borderColor: '#FF154D',
    backgroundColor: 'rgba(255,21,77,0.06)',
    borderWidth: 2.5,
    fill: true,
    tension: 0.3,
    pointRadius: 0,
    order: 0
  }
];

var platformOrder = ${JSON.stringify(platformNames)};
platformOrder.forEach(function(platform, idx) {
  if (platformTS[platform]) {
    lineDatasets.push({
      label: platform.charAt(0).toUpperCase() + platform.slice(1),
      data: platformTS[platform],
      borderColor: C[platform] || '#7a82a0',
      backgroundColor: CA[platform] || 'rgba(122,130,160,0.12)',
      borderWidth: 1.8,
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      order: idx + 1
    });
  }
});

new Chart(document.getElementById('lineChart'), {
  type: 'line',
  data: {
    labels: sparseLabels,
    datasets: lineDatasets
  },
  options: {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { maxRotation: 0 }
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        beginAtZero: true,
        ticks: { callback: function(v) { return v >= 1000 ? (v/1000).toFixed(1)+'k' : v; } }
      }
    },
    plugins: {
      legend: {
        position: 'top',
        labels: { usePointStyle: true, pointStyle: 'circle', padding: 20, font: { size: 12 } }
      },
      tooltip: {
        backgroundColor: '#1a1e2e',
        borderColor: '#2a2f45',
        borderWidth: 1,
        titleFont: { weight: '600' },
        callbacks: {
          title: function(items) { return timeLabels[items[0].dataIndex] + ' UTC'; },
          label: function(ctx) { return '  ' + ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString(); }
        }
      }
    }
  }
});

// ── Sortable Streamer Table ──
var tbody = document.getElementById('streamerBody');

function renderTable(data) {
  tbody.innerHTML = '';
  data.forEach(function(s) {
    var dotClass = 'dot-' + s.platform;
    var platName = s.platform.charAt(0).toUpperCase() + s.platform.slice(1);
    var tagClass = tierClasses[s.tier] || 'tag-community';
    tbody.innerHTML += '<tr>' +
      '<td style="font-weight:600">' + s.name + '</td>' +
      '<td style="text-align:center"><span class="badge"><span class="dot ' + dotClass + '"></span>' + platName + '</span></td>' +
      '<td style="text-align:center"><span class="tag ' + tagClass + '">' + s.tier + '</span></td>' +
      '<td style="text-align:center">' + s.lang + '</td>' +
      '<td>' + s.avg.toLocaleString() + '</td>' +
      '<td>' + s.peak.toLocaleString() + '</td>' +
      '<td>' + s.vh.toLocaleString() + '</td>' +
    '</tr>';
  });
}

var currentSort = { key: 'avg', dir: 'desc' };

function sortAndRender(key, type) {
  if (currentSort.key === key) {
    currentSort.dir = currentSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    currentSort.key = key;
    currentSort.dir = type === 'number' ? 'desc' : 'asc';
  }

  var sorted = streamerStats.slice().sort(function(a, b) {
    var va = a[key], vb = b[key];
    if (type === 'string') {
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      return currentSort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return currentSort.dir === 'asc' ? va - vb : vb - va;
  });

  document.querySelectorAll('.sortable-th').forEach(function(th) {
    th.classList.remove('asc', 'desc');
    if (th.dataset.key === key) th.classList.add(currentSort.dir);
  });

  renderTable(sorted);
}

document.querySelectorAll('.sortable-th').forEach(function(th) {
  th.addEventListener('click', function() {
    sortAndRender(th.dataset.key, th.dataset.type);
  });
});

// Initial render
renderTable(streamerStats);
</script>
</body>
</html>`;
}
