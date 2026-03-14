/**
 * Report Document Builder
 *
 * Assembles final report documents (PDF, DOCX, XLSX, CSV) from the report
 * payload, generated chart images, and agent-written narrative text.
 *
 * PDF and DOCX are built via Python subprocess (reportlab / python-docx).
 * XLSX is built via Python subprocess (openpyxl).
 * CSV is built natively in TypeScript.
 *
 * Usage:
 *   const builder = new ReportBuilder(brandingConfig);
 *   const pdfPath = await builder.buildReport(payload, charts, narratives, {
 *     format: 'pdf',
 *     scope: 'series',
 *   });
 *   const xlsxPath = await builder.buildSpreadsheet(payload, timeSeries);
 *   const csvPath = await builder.buildCSV(snapshots);
 */

import { spawn } from 'child_process';
import { mkdir, rm, writeFile, access } from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';
import { buildHTMLReport, type HTMLReportData } from './report-builder-html';

// ── Constants ───────────────────────────────────────────────────────────────

const PYTHON_BIN = process.env.PYTHON_BIN || '/usr/bin/python3';
const REPORTS_DIR = path.resolve(__dirname, 'reports');
const TIMEOUT_MS = 60_000; // 60s for full document generation

// ── Types ───────────────────────────────────────────────────────────────────

/** Branding configuration for report styling. */
export interface BrandingConfig {
  companyName?: string;
  accentColor?: string;
  accentColorRgb?: [number, number, number];
  headerBgColor?: string;
  headerBgColorRgb?: [number, number, number];
  textColor?: string;
  textColorRgb?: [number, number, number];
  mutedColor?: string;
  mutedColorRgb?: [number, number, number];
  tableHeaderBg?: string;
  tableHeaderBgRgb?: [number, number, number];
  tableHeaderText?: string;
  tableHeaderTextRgb?: [number, number, number];
  tableAltRowBg?: string;
  tableAltRowBgRgb?: [number, number, number];
  fontFamily?: string;
  /** Absolute path to company logo image. */
  logoPath?: string;
  /** Absolute path to partner logo image. */
  partnerLogoPath?: string;
}

/** The full report payload from /api/report-payload. */
export interface ReportPayload {
  generatedAt: string;
  scope: string;
  series: {
    id: string;
    name: string;
    shortName: string | null;
    game: string | null;
    partner: string | null;
    status: string;
    timezone: string;
    startDate: string | null;
    endDate: string | null;
  };
  stages: Array<{
    id: string;
    name: string;
    order: number;
    status: string;
    startDate: string | null;
    endDate: string | null;
  }>;
  broadcastDays: Array<{
    id: string;
    stageId: string;
    label: string;
    date: string;
    broadcastStart: string | null;
    broadcastEnd: string | null;
    status: string;
  }>;
  channels: Array<{
    id: string;
    platform: string;
    channelIdentifier: string;
    displayName: string;
    language: string | null;
    region: string | null;
    tier: string | null;
    source: string;
  }>;
  snapshotCount: number;
  metrics: Array<{
    broadcastDayId: string;
    peakCCV: number;
    peakTimestamp: string | null;
    avgCCV: number;
    totalViewedHours: number;
    platformBreakdown: Array<{
      platform: string;
      totalCCV: number;
      avgCCV: number;
      peakCCV: number;
    }>;
    languageBreakdown: Array<{
      language: string;
      totalCCV: number;
      avgCCV: number;
      peakCCV: number;
    }>;
    regionBreakdown: Array<{
      region: string;
      totalCCV: number;
      avgCCV: number;
      peakCCV: number;
    }>;
    tierBreakdown: Array<{
      tier: string;
      totalCCV: number;
      avgCCV: number;
      peakCCV: number;
    }>;
    channelLeaderboard: Array<{
      channelId: string;
      displayName: string;
      platform: string;
      tier?: string;
      language?: string | null;
      peakCCV: number;
      avgCCV: number;
      totalViewedMinutes?: number;
    }>;
  }>;
}

/** Map of chart names to file paths (from ChartGenerator). */
export interface ChartPaths {
  timeSeries?: string;
  stackedLanguage?: string;
  stackedRegion?: string;
  platformDonut?: string;
  languageBars?: string;
  regionBars?: string;
  channelLeaderboard?: string;
  dayOverDay?: string;
  stageComparison?: string;
}

/** Map of section names to narrative text strings (from LLM agent). */
export interface Narratives {
  executive_summary?: string;
  viewership_timeline?: string;
  platform_analysis?: string;
  audience_breakdown?: string;
  community_reach?: string;
  day_over_day?: string;
  stage_comparison?: string;
  vod_metrics?: string;
  historical_comparison?: string;
}

/** Build options. */
export interface BuildReportOptions {
  format: 'pdf' | 'docx';
  template?: string;
  scope?: string;
}

/** A time-series data point for XLSX export. */
export interface TimeSeriesDataPoint {
  timestamp: string;
  totalCCV: number;
  channelCount: number;
}

/** A flat viewership snapshot for CSV export. */
export interface SnapshotRow {
  timestamp: string;
  channel: string;
  platform: string;
  viewers: number;
  language: string | null;
  region: string | null;
  broadcastDay: string | null;
  stage: string | null;
}

/** Result from Python subprocess. */
interface PythonResult {
  status: 'ok' | 'error';
  path?: string;
  error?: string;
}

// ── ReportBuilder Class ─────────────────────────────────────────────────────

export class ReportBuilder {
  private readonly branding: BrandingConfig;
  private readonly reportId: string;
  private readonly outputDir: string;

  constructor(branding?: BrandingConfig, reportId?: string) {
    this.branding = branding ?? {};
    this.reportId = reportId ?? uuidv4();
    this.outputDir = path.join(os.tmpdir(), 'reports', this.reportId);
  }

  /** The directory where report files are written. */
  get reportsDir(): string {
    return this.outputDir;
  }

  /** Unique report identifier. */
  get id(): string {
    return this.reportId;
  }

  // ── Document Building ─────────────────────────────────────────────────

  /**
   * Build a PDF or DOCX report document.
   *
   * Assembles the full report with cover page, metrics, charts, narratives,
   * and methodology in the configured document format.
   */
  async buildReport(
    payload: ReportPayload,
    charts: ChartPaths,
    narratives: Narratives,
    options: BuildReportOptions,
  ): Promise<string> {
    const ext = options.format === 'pdf' ? 'pdf' : 'docx';
    const script = options.format === 'pdf' ? 'build_pdf.py' : 'build_docx.py';
    const outFile = `report.${ext}`;
    const outputPath = path.join(this.outputDir, outFile);

    const pythonPayload = {
      payload,
      charts,
      narratives,
      options: {
        template: options.template ?? 'standard',
        scope: options.scope ?? payload.scope,
      },
      branding: this.buildPythonBranding(),
      outputPath,
    };

    return this.runPython(script, pythonPayload);
  }

  /**
   * Build an XLSX spreadsheet with summary, channels, time series,
   * platform split, and language split tabs.
   */
  async buildSpreadsheet(
    payload: ReportPayload,
    timeSeries: TimeSeriesDataPoint[] = [],
  ): Promise<string> {
    const outputPath = path.join(this.outputDir, 'report.xlsx');

    const pythonPayload = {
      payload,
      timeSeries,
      branding: this.buildPythonBranding(),
      outputPath,
    };

    return this.runPython('build_xlsx.py', pythonPayload);
  }

  /**
   * Build an interactive HTML report.
   * Pure TypeScript — no Python subprocess needed. Uses Chart.js client-side.
   */
  async buildHTML(data: HTMLReportData): Promise<string> {
    await this.ensureOutputDir();
    const outputPath = path.join(this.outputDir, 'report.html');

    const html = buildHTMLReport(data);
    await writeFile(outputPath, html, 'utf-8');

    logger.info('HTML report generated', {
      outputPath,
      reportId: this.reportId,
      size: html.length,
    });

    return outputPath;
  }

  /**
   * Build a flat CSV export from snapshot data.
   * Pure TypeScript — no Python subprocess needed.
   */
  async buildCSV(snapshots: SnapshotRow[]): Promise<string> {
    await this.ensureOutputDir();
    const outputPath = path.join(this.outputDir, 'snapshots.csv');

    const headers = [
      'timestamp',
      'channel',
      'platform',
      'viewers',
      'language',
      'region',
      'broadcast_day',
      'stage',
    ];

    const rows = snapshots.map((s) =>
      [
        s.timestamp,
        csvEscape(s.channel),
        s.platform,
        String(s.viewers),
        s.language ?? '',
        s.region ?? '',
        s.broadcastDay ?? '',
        s.stage ?? '',
      ].join(','),
    );

    const csv = [headers.join(','), ...rows].join('\n') + '\n';
    await writeFile(outputPath, csv, 'utf-8');

    logger.info('CSV export generated', {
      outputPath,
      rows: snapshots.length,
      reportId: this.reportId,
    });

    return outputPath;
  }

  /** Remove all generated report files. */
  async cleanup(): Promise<void> {
    try {
      await rm(this.outputDir, { recursive: true, force: true });
      logger.debug('Report cleanup complete', { reportId: this.reportId });
    } catch (err) {
      logger.warn('Report cleanup failed', {
        reportId: this.reportId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  /** Ensure the output directory exists. */
  private async ensureOutputDir(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }

  /** Convert TypeScript branding config to Python-compatible format. */
  private buildPythonBranding(): Record<string, unknown> {
    const b = this.branding;
    return {
      company_name: b.companyName ?? 'Clutch Group',
      accent_color: b.accentColor ?? '#3b82f6',
      accent_color_rgb: b.accentColorRgb ?? [59, 130, 246],
      header_bg_color: b.headerBgColor ?? '#1e293b',
      header_bg_color_rgb: b.headerBgColorRgb ?? [30, 41, 59],
      text_color: b.textColor ?? '#374151',
      text_color_rgb: b.textColorRgb ?? [55, 65, 81],
      muted_color: b.mutedColor ?? '#9CA3AF',
      muted_color_rgb: b.mutedColorRgb ?? [156, 163, 175],
      table_header_bg: b.tableHeaderBg ?? '#1e293b',
      table_header_bg_rgb: b.tableHeaderBgRgb ?? [30, 41, 59],
      table_header_text: b.tableHeaderText ?? '#FFFFFF',
      table_header_text_rgb: b.tableHeaderTextRgb ?? [255, 255, 255],
      table_alt_row_bg: b.tableAltRowBg ?? '#F9FAFB',
      table_alt_row_bg_rgb: b.tableAltRowBgRgb ?? [249, 250, 251],
      font_family: b.fontFamily ?? 'Arial',
      logo_path: b.logoPath ?? null,
      partner_logo_path: b.partnerLogoPath ?? null,
    };
  }

  /**
   * Run a Python report builder script with JSON payload via stdin.
   */
  private async runPython(
    script: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    await this.ensureOutputDir();

    const scriptPath = path.join(REPORTS_DIR, script);
    const jsonPayload = JSON.stringify(payload);

    logger.debug('Building report document', {
      script,
      reportId: this.reportId,
      payloadSize: jsonPayload.length,
    });

    const startMs = Date.now();

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(PYTHON_BIN, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        const duration = Date.now() - startMs;
        logger.error('Report process spawn error', {
          script,
          error: err.message,
          duration,
          reportId: this.reportId,
        });
        reject(new ReportBuildError(
          `Failed to spawn report process: ${err.message}`,
          script,
        ));
      });

      proc.on('close', (code) => {
        const duration = Date.now() - startMs;

        if (code !== 0) {
          logger.error('Report script failed', {
            script,
            exitCode: code,
            stderr: stderr.slice(0, 2000),
            duration,
            reportId: this.reportId,
          });
          reject(new ReportBuildError(
            `Report script exited with code ${code ?? 'null'}: ${stderr.slice(0, 500)}`,
            script,
          ));
          return;
        }

        try {
          const result: PythonResult = JSON.parse(stdout.trim());
          if (result.status === 'ok' && result.path) {
            logger.info('Report document generated', {
              script,
              outputPath: result.path,
              duration,
              reportId: this.reportId,
            });
            resolve(result.path);
          } else {
            reject(new ReportBuildError(
              `Report script returned error: ${result.error ?? 'unknown'}`,
              script,
            ));
          }
        } catch {
          reject(new ReportBuildError(
            `Report script produced invalid output: ${stdout.slice(0, 200)}`,
            script,
          ));
        }
      });

      proc.stdin.write(jsonPayload);
      proc.stdin.end();
    });
  }

  /** Check if a file exists. */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// ── Error Class ─────────────────────────────────────────────────────────────

export class ReportBuildError extends Error {
  readonly script: string;

  constructor(message: string, script: string) {
    super(message);
    this.name = 'ReportBuildError';
    this.script = script;
  }
}

// ── CSV Helper ──────────────────────────────────────────────────────────────

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
