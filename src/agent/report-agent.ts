/**
 * Report Agent Orchestrator
 *
 * Coordinates chart generation, narrative writing (via Claude API), and
 * document assembly to produce complete viewership reports.
 *
 * This is the main entry point for all report generation. It:
 *   1. Fetches the report payload from the internal API
 *   2. Validates minimum data quality
 *   3. Generates all chart images via ChartGenerator
 *   4. Generates narrative sections via Claude API
 *   5. Assembles the final document via ReportBuilder
 *   6. Handles delivery (local file path, future: email, S3)
 *
 * Usage:
 *   const agent = new ReportAgent();
 *   const filePath = await agent.generateReport({
 *     scope: 'series',
 *     id: 'some-uuid',
 *     format: 'pdf',
 *   });
 */

import { mkdir } from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger';
import db from '../utils/db';
import * as TournamentSeriesModel from '../models/tournament-series';
import * as StageModel from '../models/stage';
import * as BroadcastDayModel from '../models/broadcast-day';
import * as ChannelModel from '../models/channel';
import * as ViewershipSnapshotModel from '../models/viewership-snapshot';
import {
  ChartGenerator,
  type TimeSeriesPoint,
  type GroupedTimeSeriesPoint,
  type PlatformBreakdown,
  type LanguageBreakdown,
  type RegionBreakdown,
  type ChannelLeaderboardEntry,
  type DayMetrics,
  type StageMetrics,
} from './chart-generator';
import {
  ReportBuilder,
  type BrandingConfig,
  type ReportPayload,
  type ChartPaths,
  type Narratives,
  type TimeSeriesDataPoint,
  type SnapshotRow,
} from './report-builder';
import { buildHTMLReport, type HTMLReportData } from './report-builder-html';

// ── Types ───────────────────────────────────────────────────────────────────

/** Scope for report generation. */
export type ReportScope = 'day' | 'stage' | 'multi_stage' | 'series';

/** Template presets. */
export type ReportTemplate = 'daily_recap' | 'partner_full' | 'series_retrospective' | 'standard';

/** Delivery method for generated reports. */
export type DeliveryMethod = 'local' | 'email' | 'storage';

/** Input to generateReport(). */
export interface ReportRequest {
  scope: ReportScope;
  /** UUID of the entity (broadcast day, stage, or series). */
  id?: string;
  /** For multi_stage: array of stage UUIDs. */
  ids?: string[];
  template?: ReportTemplate;
  format?: 'pdf' | 'docx' | 'html';
  deliveryMethod?: DeliveryMethod;
  branding?: BrandingConfig;
  /** If true, skip narrative generation (faster). */
  skipNarratives?: boolean;
}

/** Input to generateExport(). */
export interface ExportRequest {
  scope: ReportScope;
  id: string;
  format: 'csv' | 'xlsx';
}

/** Result returned after report generation. */
export interface ReportResult {
  filePath: string;
  scope: ReportScope;
  format: string;
  seriesName: string;
  generatedAt: string;
  duration: number;
}

/** Auto-trigger configuration stored in series metadata. */
export interface AutoReportConfig {
  dailyRecap?: boolean;
  stageReport?: boolean;
  seriesReport?: boolean;
  format?: 'pdf' | 'docx' | 'html';
}

/** Callback for auto-triggered report generation. */
export type ReportGeneratedFn = (result: ReportResult) => void;

// ── Constants ───────────────────────────────────────────────────────────────

const REPORTS_BASE_DIR = path.resolve(process.cwd(), 'reports');
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const NARRATIVE_MAX_TOKENS = 2048;

// ── ReportAgent Class ───────────────────────────────────────────────────────

export class ReportAgent {
  private readonly branding: BrandingConfig;
  private anthropic: Anthropic | null = null;
  private reportGeneratedCallback: ReportGeneratedFn | null = null;

  constructor(branding?: BrandingConfig) {
    this.branding = branding ?? {};

    // Initialize Anthropic client if API key is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    } else {
      logger.warn('[ReportAgent] ANTHROPIC_API_KEY not set — narrative generation disabled');
    }
  }

  /** Attach a callback invoked when auto-triggered reports complete. */
  setReportGeneratedCallback(fn: ReportGeneratedFn): void {
    this.reportGeneratedCallback = fn;
  }

  // ── Main Entry Points ─────────────────────────────────────────────────

  /**
   * Generate a complete viewership report.
   *
   * Orchestrates: payload fetch → validation → charts → narratives → document.
   */
  async generateReport(request: ReportRequest): Promise<ReportResult> {
    const startTime = Date.now();
    const format = request.format ?? 'pdf';
    const template = request.template ?? 'standard';
    const scope = request.scope;

    logger.info('[ReportAgent] Starting report generation', {
      scope,
      id: request.id,
      format,
      template,
    });

    // 1. Fetch the report payload
    const payload = await this.fetchReportPayload(scope, request.id, request.ids);

    // 2. Validate minimum data quality
    this.validatePayload(payload);

    let finalPath: string;
    const deliveryMethod = request.deliveryMethod ?? 'local';

    if (format === 'html') {
      // ── HTML Report: Chart.js client-side, no Python ─────────────────
      // 3. Fetch time series data (total + per-platform)
      const totalTimeSeries = await this.fetchAllTimeSeries(payload.broadcastDays);
      const platformTimeSeries = await this.fetchGroupedTimeSeries(payload.broadcastDays, 'platform');

      // 4. Generate narratives
      let narratives: Narratives = {};
      if (!request.skipNarratives && this.anthropic) {
        try {
          narratives = await this.generateNarratives(payload, scope, template);
        } catch (err) {
          logger.error('[ReportAgent] Narrative generation failed — continuing without narratives', {
            error: (err as Error).message,
          });
        }
      }

      // 5. Aggregate metrics and build HTML
      const aggregated = this.aggregateMetrics(payload.metrics);
      const builder = new ReportBuilder(request.branding ?? this.branding);
      const htmlData: HTMLReportData = {
        payload,
        totalTimeSeries,
        platformTimeSeries: platformTimeSeries.map((p) => ({
          timestamp: p.timestamp,
          groupKey: p.groupKey,
          totalCCV: p.totalCCV,
          channelCount: p.channelCount,
        })),
        aggregated,
        narratives,
      };
      const tmpPath = await builder.buildHTML(htmlData);

      // 6. Handle delivery
      finalPath = await this.handleDelivery(tmpPath, payload, scope, format, deliveryMethod);
    } else {
      // ── PDF / DOCX: Python subprocess with matplotlib charts ──────────
      // 3. Generate charts
      const chartGenerator = new ChartGenerator();
      let charts: ChartPaths = {};
      try {
        charts = await this.generateCharts(chartGenerator, payload, scope);
      } catch (err) {
        logger.error('[ReportAgent] Chart generation failed — continuing without charts', {
          error: (err as Error).message,
        });
      }

      // 4. Generate narrative sections via Claude API
      let narratives: Narratives = {};
      if (!request.skipNarratives && this.anthropic) {
        try {
          narratives = await this.generateNarratives(payload, scope, template);
        } catch (err) {
          logger.error('[ReportAgent] Narrative generation failed — continuing without narratives', {
            error: (err as Error).message,
          });
        }
      }

      // 5. Assemble the final document
      const builder = new ReportBuilder(request.branding ?? this.branding);
      const tmpPath = await builder.buildReport(payload, charts, narratives, {
        format,
        template,
        scope,
      });

      // 6. Handle delivery
      finalPath = await this.handleDelivery(tmpPath, payload, scope, format, deliveryMethod);

      // 7. Cleanup temp files
      await chartGenerator.cleanup();
    }

    const duration = Date.now() - startTime;
    const result: ReportResult = {
      filePath: finalPath,
      scope,
      format,
      seriesName: payload.series.name,
      generatedAt: new Date().toISOString(),
      duration,
    };

    logger.info('[ReportAgent] Report generation complete', {
      filePath: finalPath,
      scope,
      format,
      duration,
      seriesName: payload.series.name,
    });

    return result;
  }

  /** Convenience: generate a daily recap PDF. */
  async generateDailyRecap(broadcastDayId: string): Promise<ReportResult> {
    return this.generateReport({
      scope: 'day',
      id: broadcastDayId,
      template: 'daily_recap',
      format: 'pdf',
    });
  }

  /** Convenience: generate a stage report PDF. */
  async generateStageReport(stageId: string): Promise<ReportResult> {
    return this.generateReport({
      scope: 'stage',
      id: stageId,
      template: 'partner_full',
      format: 'pdf',
    });
  }

  /** Convenience: generate a full series retrospective PDF. */
  async generateSeriesReport(seriesId: string): Promise<ReportResult> {
    return this.generateReport({
      scope: 'series',
      id: seriesId,
      template: 'series_retrospective',
      format: 'pdf',
    });
  }

  /**
   * Generate a data export (CSV or XLSX) without narratives or charts.
   */
  async generateExport(request: ExportRequest): Promise<ReportResult> {
    const startTime = Date.now();
    const { scope, id, format } = request;

    logger.info('[ReportAgent] Starting data export', { scope, id, format });

    if (format === 'xlsx') {
      // Fetch payload and time series data for XLSX
      const payload = await this.fetchReportPayload(scope, id);
      const timeSeries = await this.fetchTimeSeries(scope, id);
      const builder = new ReportBuilder(this.branding);
      const tmpPath = await builder.buildSpreadsheet(payload, timeSeries);
      const finalPath = await this.handleDelivery(tmpPath, payload, scope, 'xlsx', 'local');

      return {
        filePath: finalPath,
        scope,
        format: 'xlsx',
        seriesName: payload.series.name,
        generatedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
    }

    // CSV export: fetch raw snapshots
    const snapshots = await this.fetchSnapshotRows(scope, id);
    const payload = await this.fetchReportPayload(scope, id);
    const builder = new ReportBuilder(this.branding);
    const tmpPath = await builder.buildCSV(snapshots);
    const finalPath = await this.handleDelivery(tmpPath, payload, scope, 'csv', 'local');

    return {
      filePath: finalPath,
      scope,
      format: 'csv',
      seriesName: payload.series.name,
      generatedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  }

  // ── Auto-Trigger Hooks ────────────────────────────────────────────────

  /**
   * Called when a broadcast day transitions to 'completed'.
   * Checks series metadata for auto-report config and triggers daily recap.
   */
  async onBroadcastDayCompleted(broadcastDayId: string, seriesId: string): Promise<void> {
    const autoConfig = await this.getAutoReportConfig(seriesId);
    if (!autoConfig?.dailyRecap) {
      logger.debug('[ReportAgent] Auto daily recap disabled for series', { seriesId });
      return;
    }

    logger.info('[ReportAgent] Auto-triggering daily recap', { broadcastDayId, seriesId });
    try {
      const result = await this.generateDailyRecap(broadcastDayId);
      this.reportGeneratedCallback?.(result);
    } catch (err) {
      logger.error('[ReportAgent] Auto daily recap failed', {
        broadcastDayId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Called when all broadcast days in a stage are 'completed'.
   * Checks series metadata for auto-report config and triggers stage report.
   */
  async onStageCompleted(stageId: string, seriesId: string): Promise<void> {
    const autoConfig = await this.getAutoReportConfig(seriesId);
    if (!autoConfig?.stageReport) {
      logger.debug('[ReportAgent] Auto stage report disabled for series', { seriesId });
      return;
    }

    logger.info('[ReportAgent] Auto-triggering stage report', { stageId, seriesId });
    try {
      const result = await this.generateStageReport(stageId);
      this.reportGeneratedCallback?.(result);
    } catch (err) {
      logger.error('[ReportAgent] Auto stage report failed', {
        stageId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Called when all stages in a series are 'completed'.
   * Checks series metadata for auto-report config and triggers series report.
   */
  async onSeriesCompleted(seriesId: string): Promise<void> {
    const autoConfig = await this.getAutoReportConfig(seriesId);
    if (!autoConfig?.seriesReport) {
      logger.debug('[ReportAgent] Auto series report disabled for series', { seriesId });
      return;
    }

    logger.info('[ReportAgent] Auto-triggering series report', { seriesId });
    try {
      const result = await this.generateSeriesReport(seriesId);
      this.reportGeneratedCallback?.(result);
    } catch (err) {
      logger.error('[ReportAgent] Auto series report failed', {
        seriesId,
        error: (err as Error).message,
      });
    }
  }

  // ── Private: Payload Fetching ─────────────────────────────────────────

  /**
   * Fetch the full report payload by directly querying the database.
   * Mirrors the logic in /api/report-payload but avoids an HTTP roundtrip.
   */
  private async fetchReportPayload(
    scope: ReportScope,
    id?: string,
    ids?: string[],
  ): Promise<ReportPayload> {
    let seriesId: string | undefined;
    let stageIds: string[] = [];
    let broadcastDayIds: string[] = [];

    switch (scope) {
      case 'series': {
        if (!id) throw new ReportAgentError('id is required for scope=series');
        seriesId = id;
        const stages = await StageModel.findAll({ series_id: seriesId });
        stageIds = stages.map((s) => s.id);
        const days = await BroadcastDayModel.findAll({ series_id: seriesId });
        broadcastDayIds = days.map((d) => d.id);
        break;
      }

      case 'stage': {
        if (!id) throw new ReportAgentError('id is required for scope=stage');
        const stage = await StageModel.findById(id);
        if (!stage) throw new ReportAgentError(`Stage not found: ${id}`);
        seriesId = stage.series_id;
        stageIds = [stage.id];
        const days = await BroadcastDayModel.findAll({ stage_id: stage.id });
        broadcastDayIds = days.map((d) => d.id);
        break;
      }

      case 'multi_stage': {
        if (!ids || ids.length === 0) {
          throw new ReportAgentError('ids array is required for scope=multi_stage');
        }
        stageIds = ids;
        for (const sid of ids) {
          const stage = await StageModel.findById(sid);
          if (!stage) throw new ReportAgentError(`Stage not found: ${sid}`);
          if (!seriesId) seriesId = stage.series_id;
          const days = await BroadcastDayModel.findAll({ stage_id: sid });
          broadcastDayIds.push(...days.map((d) => d.id));
        }
        break;
      }

      case 'day': {
        if (!id) throw new ReportAgentError('id is required for scope=day');
        const day = await BroadcastDayModel.findById(id);
        if (!day) throw new ReportAgentError(`Broadcast day not found: ${id}`);
        seriesId = day.series_id;
        stageIds = [day.stage_id];
        broadcastDayIds = [day.id];
        break;
      }
    }

    if (!seriesId) throw new ReportAgentError('Could not determine series');

    const series = await TournamentSeriesModel.findById(seriesId);
    if (!series) throw new ReportAgentError(`Series not found: ${seriesId}`);

    const stages = stageIds.length > 0
      ? await db('stages').whereIn('id', stageIds).orderBy('order', 'asc')
      : [];

    const broadcastDays = broadcastDayIds.length > 0
      ? await db('broadcast_days').whereIn('id', broadcastDayIds).orderBy('date', 'asc')
      : [];

    const channels = await ChannelModel.findAll({ series_id: seriesId, is_active: true });

    // Compute per-day metrics
    const dayMetrics = await Promise.all(
      broadcastDayIds.map(async (dayId) => {
        const scopeObj: ViewershipSnapshotModel.Scope = { level: 'day', id: dayId };
        const [peak, avg, hours, platforms, languages, regions, leaderboard] = await Promise.all([
          ViewershipSnapshotModel.getPeakCCV(scopeObj),
          ViewershipSnapshotModel.getAverageCCV(scopeObj),
          ViewershipSnapshotModel.getTotalViewedHours(scopeObj),
          ViewershipSnapshotModel.getPlatformBreakdown(scopeObj),
          ViewershipSnapshotModel.getLanguageBreakdown(scopeObj),
          ViewershipSnapshotModel.getRegionBreakdown(scopeObj),
          ViewershipSnapshotModel.getChannelLeaderboard(scopeObj, 10),
        ]);
        return {
          broadcastDayId: dayId,
          peakCCV: peak ? parseInt(peak.total_ccv, 10) : 0,
          peakTimestamp: peak?.timestamp ? new Date(peak.timestamp).toISOString() : null,
          avgCCV: parseFloat(avg),
          totalViewedHours: parseFloat(hours),
          platformBreakdown: platforms.map((b) => ({
            platform: b.key,
            totalCCV: parseInt(b.total_ccv, 10),
            avgCCV: parseFloat(b.avg_ccv),
            peakCCV: parseInt(b.peak_ccv, 10),
          })),
          languageBreakdown: languages.map((b) => ({
            language: b.key,
            totalCCV: parseInt(b.total_ccv, 10),
            avgCCV: parseFloat(b.avg_ccv),
            peakCCV: parseInt(b.peak_ccv, 10),
          })),
          regionBreakdown: regions.map((b) => ({
            region: b.key,
            totalCCV: parseInt(b.total_ccv, 10),
            avgCCV: parseFloat(b.avg_ccv),
            peakCCV: parseInt(b.peak_ccv, 10),
          })),
          channelLeaderboard: leaderboard.map((e) => ({
            channelId: e.channel_id,
            displayName: e.display_name,
            platform: e.platform,
            peakCCV: parseInt(e.peak_ccv, 10),
            avgCCV: parseFloat(e.avg_ccv),
            totalViewedMinutes: parseInt(e.total_viewed_minutes, 10),
          })),
        };
      }),
    );

    const snapshotCount = await db('viewership_snapshots')
      .where('series_id', seriesId)
      .whereIn('broadcast_day_id', broadcastDayIds.length > 0 ? broadcastDayIds : ['__none__'])
      .count('* as count')
      .first();

    return {
      generatedAt: new Date().toISOString(),
      scope,
      series: {
        id: series.id,
        name: series.name,
        shortName: series.short_name,
        game: series.game,
        partner: series.partner,
        status: series.status,
        timezone: series.timezone ?? 'UTC',
        startDate: series.start_date,
        endDate: series.end_date,
      },
      stages: stages.map((s: { id: string; name: string; order: number; status: string; start_date: string | null; end_date: string | null }) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        status: s.status,
        startDate: s.start_date,
        endDate: s.end_date,
      })),
      broadcastDays: broadcastDays.map((d: { id: string; stage_id: string; label: string; date: string; broadcast_start: string | null; broadcast_end: string | null; status: string }) => ({
        id: d.id,
        stageId: d.stage_id,
        label: d.label,
        date: d.date,
        broadcastStart: d.broadcast_start,
        broadcastEnd: d.broadcast_end,
        status: d.status,
      })),
      channels: channels.map((c) => ({
        id: c.id,
        platform: c.platform,
        channelIdentifier: c.channel_identifier,
        displayName: c.display_name,
        language: c.language,
        region: c.region,
        tier: c.tier,
        source: c.source,
      })),
      snapshotCount: parseInt((snapshotCount as { count: string })?.count ?? '0', 10),
      metrics: dayMetrics,
    };
  }

  /** Fetch time series data for XLSX export. */
  private async fetchTimeSeries(
    scope: ReportScope,
    id: string,
  ): Promise<TimeSeriesDataPoint[]> {
    const scopeObj: ViewershipSnapshotModel.Scope = {
      level: scope === 'multi_stage' ? 'series' : (scope as 'day' | 'stage' | 'series'),
      id,
    };

    const buckets = await ViewershipSnapshotModel.getTimeSeriesData(scopeObj, 300);
    return buckets.map((b) => ({
      timestamp: new Date(b.bucket).toISOString(),
      totalCCV: parseInt(b.total_ccv, 10),
      channelCount: parseInt(b.channel_count, 10),
    }));
  }

  /** Fetch raw snapshot rows for CSV export. */
  private async fetchSnapshotRows(
    scope: ReportScope,
    id: string,
  ): Promise<SnapshotRow[]> {
    const scopeColumn = scope === 'day' ? 'viewership_snapshots.broadcast_day_id'
      : scope === 'stage' ? 'viewership_snapshots.stage_id'
      : 'viewership_snapshots.series_id';

    const rows = await db('viewership_snapshots')
      .where(scopeColumn, id)
      .join('channels', 'channels.id', 'viewership_snapshots.channel_id')
      .leftJoin('broadcast_days', 'broadcast_days.id', 'viewership_snapshots.broadcast_day_id')
      .leftJoin('stages', 'stages.id', 'viewership_snapshots.stage_id')
      .select(
        'viewership_snapshots.timestamp',
        'channels.display_name as channel',
        'viewership_snapshots.platform',
        'viewership_snapshots.concurrent_viewers as viewers',
        'viewership_snapshots.language',
        'viewership_snapshots.region',
        'broadcast_days.label as broadcastDay',
        'stages.name as stage',
      )
      .orderBy('viewership_snapshots.timestamp', 'asc');

    return rows.map((r: { timestamp: Date; channel: string; platform: string; viewers: number; language: string | null; region: string | null; broadcastDay: string | null; stage: string | null }) => ({
      timestamp: new Date(r.timestamp).toISOString(),
      channel: r.channel,
      platform: r.platform,
      viewers: r.viewers,
      language: r.language,
      region: r.region,
      broadcastDay: r.broadcastDay,
      stage: r.stage,
    }));
  }

  // ── Private: Validation ───────────────────────────────────────────────

  /** Validate the payload has minimum data quality. */
  private validatePayload(payload: ReportPayload): void {
    if (!payload.series.id) {
      throw new ReportAgentError('Payload missing series information');
    }
    if (payload.broadcastDays.length === 0) {
      throw new ReportAgentError('No broadcast days found in payload');
    }
    // Allow reports with zero snapshots — they'll just show "no data"
    if (payload.snapshotCount === 0) {
      logger.warn('[ReportAgent] Generating report with zero snapshots', {
        seriesName: payload.series.name,
        scope: payload.scope,
      });
    }
  }

  // ── Private: Chart Generation ─────────────────────────────────────────

  /** Generate all applicable charts for this report scope. */
  private async generateCharts(
    gen: ChartGenerator,
    payload: ReportPayload,
    scope: ReportScope,
  ): Promise<ChartPaths> {
    const scopeLabel = this.buildScopeLabel(payload);

    // Aggregate metrics across all broadcast days
    const agg = this.aggregateMetrics(payload.metrics);

    // Fetch time series data for each broadcast day
    const timeSeriesData = await this.fetchAllTimeSeries(payload.broadcastDays);

    // Build chart generation params based on available data
    const chartParams: Parameters<ChartGenerator['generateAll']>[0] = {};

    // Time series chart
    if (timeSeriesData.length > 0) {
      chartParams.timeSeries = {
        data: timeSeriesData,
        options: { title: 'Viewership Timeline', scopeLabel },
      };
    }

    // Platform donut
    if (agg.platformBreakdown.length > 0) {
      chartParams.platformDonut = {
        data: agg.platformBreakdown,
        options: { title: 'Platform Distribution', scopeLabel },
      };
    }

    // Language bars
    if (agg.languageBreakdown.length > 0) {
      chartParams.languageBars = {
        data: agg.languageBreakdown,
        options: { title: 'Language Distribution', scopeLabel },
      };
    }

    // Region bars
    if (agg.regionBreakdown.length > 0) {
      chartParams.regionBars = {
        data: agg.regionBreakdown,
        options: { title: 'Region Distribution', scopeLabel },
      };
    }

    // Channel leaderboard
    if (agg.channelLeaderboard.length > 0) {
      chartParams.channelLeaderboard = {
        data: agg.channelLeaderboard,
        options: { title: 'Channel Leaderboard', scopeLabel },
      };
    }

    // Day-over-day (for stage/series scope)
    if ((scope === 'stage' || scope === 'series' || scope === 'multi_stage') &&
        payload.metrics.length > 1) {
      const dayLookup = new Map(
        payload.broadcastDays.map((d) => [d.id, d]),
      );
      const dayMetrics: DayMetrics[] = payload.metrics
        .filter((m) => m.peakCCV > 0)
        .map((m) => {
          const day = dayLookup.get(m.broadcastDayId);
          return {
            dayLabel: day?.label ?? 'Unknown',
            date: day?.date ?? '',
            peakCCV: m.peakCCV,
            avgCCV: m.avgCCV,
            totalViewedHours: m.totalViewedHours,
          };
        });
      if (dayMetrics.length > 1) {
        chartParams.dayOverDay = {
          data: dayMetrics,
          options: { title: 'Day-over-Day Trend', scopeLabel },
        };
      }
    }

    // Stage comparison (for series scope)
    if (scope === 'series' && payload.stages.length > 1) {
      const stageMetrics = this.computeStageMetrics(payload);
      if (stageMetrics.length > 1) {
        chartParams.stageComparison = {
          data: stageMetrics,
          options: { title: 'Stage Comparison', scopeLabel },
        };
      }
    }

    return gen.generateAll(chartParams);
  }

  /** Fetch time series data for all broadcast days and merge into one array. */
  private async fetchAllTimeSeries(
    broadcastDays: ReportPayload['broadcastDays'],
  ): Promise<TimeSeriesPoint[]> {
    const allPoints: TimeSeriesPoint[] = [];

    for (const day of broadcastDays) {
      try {
        const buckets = await ViewershipSnapshotModel.getTimeSeriesData(
          { level: 'day', id: day.id },
          300, // 5-min buckets
        );
        for (const b of buckets) {
          allPoints.push({
            timestamp: new Date(b.bucket).toISOString(),
            totalCCV: parseInt(b.total_ccv, 10),
            channelCount: parseInt(b.channel_count, 10),
          });
        }
      } catch {
        // Skip days with no data
      }
    }

    return allPoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Fetch grouped time series data for all broadcast days and merge into one array.
   * Used by the HTML report builder for per-platform line chart overlays.
   */
  private async fetchGroupedTimeSeries(
    broadcastDays: ReportPayload['broadcastDays'],
    groupBy: 'platform' | 'language',
  ): Promise<GroupedTimeSeriesPoint[]> {
    const allPoints: GroupedTimeSeriesPoint[] = [];

    for (const day of broadcastDays) {
      try {
        const buckets = await ViewershipSnapshotModel.getGroupedTimeSeriesData(
          { level: 'day', id: day.id },
          groupBy,
          300, // 5-min buckets
        );
        for (const b of buckets) {
          allPoints.push({
            timestamp: new Date(b.bucket).toISOString(),
            groupKey: b.group_key ?? 'unknown',
            totalCCV: parseInt(b.total_ccv, 10),
            channelCount: parseInt(b.channel_count, 10),
          });
        }
      } catch {
        // Skip days with no data
      }
    }

    return allPoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /** Aggregate metrics across all broadcast days. */
  private aggregateMetrics(metrics: ReportPayload['metrics']): {
    peakCCV: number;
    avgCCV: number;
    totalViewedHours: number;
    platformBreakdown: PlatformBreakdown[];
    languageBreakdown: LanguageBreakdown[];
    regionBreakdown: RegionBreakdown[];
    channelLeaderboard: ChannelLeaderboardEntry[];
  } {
    if (metrics.length === 0) {
      return {
        peakCCV: 0,
        avgCCV: 0,
        totalViewedHours: 0,
        platformBreakdown: [],
        languageBreakdown: [],
        regionBreakdown: [],
        channelLeaderboard: [],
      };
    }

    // Overall peak
    const peakMetric = metrics.reduce((a, b) => a.peakCCV > b.peakCCV ? a : b);
    const peakCCV = peakMetric.peakCCV;

    // Average of averages
    const avgCCV = Math.round(
      metrics.reduce((sum, m) => sum + m.avgCCV, 0) / metrics.length,
    );

    // Total viewed hours
    const totalViewedHours = metrics.reduce((sum, m) => sum + m.totalViewedHours, 0);

    // Merge platform breakdowns
    const platformMap = new Map<string, PlatformBreakdown>();
    let platformCount = 0;
    for (const m of metrics) {
      for (const p of m.platformBreakdown) {
        const existing = platformMap.get(p.platform);
        if (existing) {
          existing.totalCCV += p.totalCCV;
          existing.avgCCV += p.avgCCV;
          existing.peakCCV = Math.max(existing.peakCCV, p.peakCCV);
        } else {
          platformMap.set(p.platform, { ...p });
        }
      }
      if (m.platformBreakdown.length > 0) platformCount++;
    }
    const platformBreakdown = [...platformMap.values()].map((p) => ({
      ...p,
      avgCCV: platformCount > 0 ? Math.round(p.avgCCV / platformCount) : 0,
    })).sort((a, b) => b.totalCCV - a.totalCCV);

    // Merge language breakdowns
    const langMap = new Map<string, LanguageBreakdown>();
    let langCount = 0;
    for (const m of metrics) {
      for (const l of m.languageBreakdown) {
        const existing = langMap.get(l.language);
        if (existing) {
          existing.totalCCV += l.totalCCV;
          existing.avgCCV += l.avgCCV;
          existing.peakCCV = Math.max(existing.peakCCV, l.peakCCV);
        } else {
          langMap.set(l.language, { ...l });
        }
      }
      if (m.languageBreakdown.length > 0) langCount++;
    }
    const languageBreakdown = [...langMap.values()].map((l) => ({
      ...l,
      avgCCV: langCount > 0 ? Math.round(l.avgCCV / langCount) : 0,
    })).sort((a, b) => b.totalCCV - a.totalCCV);

    // Merge region breakdowns
    const regionMap = new Map<string, RegionBreakdown>();
    let regionCount = 0;
    for (const m of metrics) {
      for (const r of m.regionBreakdown) {
        const existing = regionMap.get(r.region);
        if (existing) {
          existing.totalCCV += r.totalCCV;
          existing.avgCCV += r.avgCCV;
          existing.peakCCV = Math.max(existing.peakCCV, r.peakCCV);
        } else {
          regionMap.set(r.region, { ...r });
        }
      }
      if (m.regionBreakdown.length > 0) regionCount++;
    }
    const regionBreakdown = [...regionMap.values()].map((r) => ({
      ...r,
      avgCCV: regionCount > 0 ? Math.round(r.avgCCV / regionCount) : 0,
    })).sort((a, b) => b.totalCCV - a.totalCCV);

    // Merge channel leaderboards (take best per channel)
    const channelMap = new Map<string, ChannelLeaderboardEntry>();
    for (const m of metrics) {
      for (const ch of m.channelLeaderboard) {
        const existing = channelMap.get(ch.channelId);
        if (!existing || ch.peakCCV > existing.peakCCV) {
          channelMap.set(ch.channelId, {
            channelId: ch.channelId,
            displayName: ch.displayName,
            platform: ch.platform,
            peakCCV: ch.peakCCV,
            avgCCV: ch.avgCCV,
            totalViewedMinutes: ch.totalViewedMinutes ?? 0,
          });
        }
      }
    }
    const channelLeaderboard = [...channelMap.values()]
      .sort((a, b) => b.peakCCV - a.peakCCV)
      .slice(0, 20);

    return {
      peakCCV,
      avgCCV,
      totalViewedHours,
      platformBreakdown,
      languageBreakdown,
      regionBreakdown,
      channelLeaderboard,
    };
  }

  /** Compute per-stage aggregated metrics for stage comparison chart. */
  private computeStageMetrics(payload: ReportPayload): StageMetrics[] {
    return payload.stages.map((stage) => {
      const stageDayIds = new Set(
        payload.broadcastDays
          .filter((d) => d.stageId === stage.id)
          .map((d) => d.id),
      );
      const stageMetrics = payload.metrics.filter((m) => stageDayIds.has(m.broadcastDayId));

      const peakCCV = stageMetrics.length > 0
        ? Math.max(...stageMetrics.map((m) => m.peakCCV))
        : 0;
      const avgCCV = stageMetrics.length > 0
        ? Math.round(stageMetrics.reduce((s, m) => s + m.avgCCV, 0) / stageMetrics.length)
        : 0;
      const totalViewedHours = stageMetrics.reduce((s, m) => s + m.totalViewedHours, 0);

      // Unique channels across leaderboards
      const channelIds = new Set<string>();
      for (const m of stageMetrics) {
        for (const ch of m.channelLeaderboard) {
          channelIds.add(ch.channelId);
        }
      }

      return {
        stageName: stage.name,
        peakCCV,
        avgCCV,
        totalViewedHours,
        channelCount: channelIds.size,
      };
    });
  }

  // ── Private: Narrative Generation ─────────────────────────────────────

  /**
   * Generate narrative text sections via the Claude API.
   * Returns structured narratives keyed by section name.
   */
  private async generateNarratives(
    payload: ReportPayload,
    scope: ReportScope,
    template: ReportTemplate,
  ): Promise<Narratives> {
    if (!this.anthropic) return {};

    const agg = this.aggregateMetrics(payload.metrics);
    const scopeLabel = this.buildScopeLabel(payload);

    // Build the context prompt
    const contextBlock = this.buildNarrativeContext(payload, agg, scope, template, scopeLabel);

    const prompt = `You are a professional esports analytics writer creating a viewership report.

${contextBlock}

Write the following narrative sections for this report. Each section should be 2-4 sentences, professional but engaging. Use specific numbers from the data provided.

Return ONLY a JSON object with the following keys (include only sections relevant to the scope):
- "executive_summary": High-level overview of viewership performance
- "viewership_timeline": Commentary on the viewership trend over time
- "platform_analysis": Analysis of platform distribution and performance
- "audience_breakdown": Commentary on language and region distribution
- "community_reach": Commentary on community channels and organic viewership${scope !== 'day' ? `
- "day_over_day": Trend analysis across broadcast days` : ''}${scope === 'series' ? `
- "stage_comparison": Comparison of performance across tournament stages` : ''}

Respond with ONLY the JSON object, no markdown code blocks.`;

    try {
      logger.debug('[ReportAgent] Generating narratives via Claude API');
      const response = await this.anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: NARRATIVE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        logger.warn('[ReportAgent] Claude returned no text content');
        return {};
      }

      // Parse the JSON response — handle possible markdown wrapping
      let jsonStr = textContent.text.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const narratives: Narratives = JSON.parse(jsonStr);
      logger.info('[ReportAgent] Narratives generated', {
        sections: Object.keys(narratives),
      });
      return narratives;
    } catch (err) {
      logger.error('[ReportAgent] Claude API call failed', {
        error: (err as Error).message,
      });
      return {};
    }
  }

  /** Build contextual information for the narrative generation prompt. */
  private buildNarrativeContext(
    payload: ReportPayload,
    agg: ReturnType<ReportAgent['aggregateMetrics']>,
    scope: ReportScope,
    template: ReportTemplate,
    scopeLabel: string,
  ): string {
    const series = payload.series;
    const parts: string[] = [];

    parts.push(`## Event Context`);
    parts.push(`- Event: ${series.name}`);
    if (series.game) parts.push(`- Game: ${series.game}`);
    if (series.partner) parts.push(`- Partner: ${series.partner}`);
    parts.push(`- Scope: ${scope} — ${scopeLabel}`);
    parts.push(`- Template: ${template}`);

    parts.push(`\n## Key Metrics`);
    parts.push(`- Peak CCV: ${agg.peakCCV.toLocaleString()}`);
    parts.push(`- Average CCV: ${agg.avgCCV.toLocaleString()}`);
    parts.push(`- Total Viewed Hours: ${Math.round(agg.totalViewedHours).toLocaleString()}`);
    parts.push(`- Tracked Channels: ${payload.channels.length}`);
    parts.push(`- Broadcast Days: ${payload.broadcastDays.length}`);
    parts.push(`- Total Snapshots: ${payload.snapshotCount.toLocaleString()}`);

    if (agg.platformBreakdown.length > 0) {
      parts.push(`\n## Platform Breakdown`);
      for (const p of agg.platformBreakdown) {
        parts.push(`- ${p.platform}: Total CCV ${p.totalCCV.toLocaleString()}, Peak ${p.peakCCV.toLocaleString()}, Avg ${p.avgCCV.toLocaleString()}`);
      }
    }

    if (agg.languageBreakdown.length > 0) {
      parts.push(`\n## Language Breakdown`);
      for (const l of agg.languageBreakdown.slice(0, 8)) {
        parts.push(`- ${l.language}: Total CCV ${l.totalCCV.toLocaleString()}`);
      }
    }

    if (agg.channelLeaderboard.length > 0) {
      parts.push(`\n## Top Channels`);
      for (const ch of agg.channelLeaderboard.slice(0, 5)) {
        parts.push(`- ${ch.displayName} (${ch.platform}): Peak ${ch.peakCCV.toLocaleString()}`);
      }
    }

    if (scope !== 'day' && payload.metrics.length > 1) {
      parts.push(`\n## Day-by-Day Summary`);
      const dayLookup = new Map(
        payload.broadcastDays.map((d) => [d.id, d]),
      );
      for (const m of payload.metrics.filter((m) => m.peakCCV > 0)) {
        const day = dayLookup.get(m.broadcastDayId);
        parts.push(`- ${day?.label ?? 'Unknown'}: Peak ${m.peakCCV.toLocaleString()}, Avg ${m.avgCCV.toLocaleString()}`);
      }
    }

    return parts.join('\n');
  }

  // ── Private: Delivery ─────────────────────────────────────────────────

  /**
   * Handle delivery of the generated report file.
   * Currently supports 'local' — copies to a permanent path.
   */
  private async handleDelivery(
    tmpPath: string,
    payload: ReportPayload,
    scope: ReportScope,
    format: string,
    method: DeliveryMethod,
  ): Promise<string> {
    const shortName = (payload.series.shortName ?? payload.series.name)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase();
    const date = new Date().toISOString().split('T')[0];
    const filename = `${scope}_${date}.${format}`;

    switch (method) {
      case 'local': {
        const dir = path.join(REPORTS_BASE_DIR, shortName);
        await mkdir(dir, { recursive: true });
        const finalPath = path.join(dir, filename);

        // Copy from temp to permanent location
        const { copyFile } = await import('fs/promises');
        await copyFile(tmpPath, finalPath);

        logger.info('[ReportAgent] Report delivered locally', { finalPath });
        return finalPath;
      }

      case 'email': {
        // Future: integrate with email service
        logger.warn('[ReportAgent] Email delivery not yet implemented — falling back to local');
        return this.handleDelivery(tmpPath, payload, scope, format, 'local');
      }

      case 'storage': {
        // Future: upload to S3/Google Drive
        logger.warn('[ReportAgent] Storage delivery not yet implemented — falling back to local');
        return this.handleDelivery(tmpPath, payload, scope, format, 'local');
      }
    }
  }

  // ── Private: Helpers ──────────────────────────────────────────────────

  /** Build a human-readable scope label. */
  private buildScopeLabel(payload: ReportPayload): string {
    const scope = payload.scope;
    if (scope === 'day' && payload.broadcastDays.length > 0) {
      const day = payload.broadcastDays[0];
      const stage = payload.stages.find((s) => s.id === day?.stageId);
      return stage ? `${day?.label} — ${stage.name}` : (day?.label ?? 'Day');
    }
    if (scope === 'stage' && payload.stages.length > 0) {
      return payload.stages[0]?.name ?? 'Stage';
    }
    if (scope === 'multi_stage' && payload.stages.length > 0) {
      return payload.stages.map((s) => s.name).join(', ');
    }
    return payload.series.name;
  }

  /** Read auto-report configuration from series metadata. */
  private async getAutoReportConfig(seriesId: string): Promise<AutoReportConfig | null> {
    const series = await TournamentSeriesModel.findById(seriesId);
    if (!series) return null;

    const metadata = series.metadata ?? {};
    const config = metadata['autoReports'] as AutoReportConfig | undefined;
    return config ?? null;
  }
}

// ── Error Class ─────────────────────────────────────────────────────────────

export class ReportAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportAgentError';
  }
}
