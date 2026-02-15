/**
 * Chart Generation Service
 *
 * Generates print-quality PNG chart images for reports by delegating to
 * Python/matplotlib scripts via child process.  Each chart type has a
 * dedicated Python script in ./charts/ that reads JSON from stdin and
 * writes a PNG to a specified path.
 *
 * Usage:
 *   const gen = new ChartGenerator(reportId);
 *   const path = await gen.generateTimeSeriesChart(data, options);
 *   // path = /tmp/charts/<reportId>/time_series.png
 *   await gen.cleanup(); // remove temp files when done
 */

import { spawn } from 'child_process';
import { mkdir, rm, access } from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

// ── Constants ───────────────────────────────────────────────────────────────

const PYTHON_BIN = process.env.PYTHON_BIN || '/usr/bin/python3';
const CHARTS_DIR = path.resolve(__dirname, 'charts');
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config', 'chart-config.json');
const TIMEOUT_MS = 30_000; // 30s per chart generation

// ── Input Types ─────────────────────────────────────────────────────────────

/** A single CCV data point for time-series charts. */
export interface TimeSeriesPoint {
  timestamp: string;
  totalCCV: number;
  channelCount: number;
}

/** A grouped CCV data point (language/region/platform overlay). */
export interface GroupedTimeSeriesPoint {
  timestamp: string;
  groupKey: string;
  totalCCV: number;
  channelCount: number;
}

/** Platform breakdown entry from the metrics API. */
export interface PlatformBreakdown {
  platform: string;
  totalCCV: number;
  avgCCV: number;
  peakCCV: number;
}

/** Language breakdown entry from the metrics API. */
export interface LanguageBreakdown {
  language: string;
  totalCCV: number;
  avgCCV: number;
  peakCCV: number;
}

/** Region breakdown entry from the metrics API. */
export interface RegionBreakdown {
  region: string;
  totalCCV: number;
  avgCCV: number;
  peakCCV: number;
}

/** Channel leaderboard entry from the metrics API. */
export interface ChannelLeaderboardEntry {
  channelId: string;
  displayName: string;
  platform: string;
  peakCCV: number;
  avgCCV: number;
  totalViewedMinutes: number;
}

/** Per-broadcast-day aggregated metrics for day-over-day charts. */
export interface DayMetrics {
  dayLabel: string;
  date: string;
  peakCCV: number;
  avgCCV: number;
  totalViewedHours: number;
}

/** Per-stage aggregated metrics for stage comparison charts. */
export interface StageMetrics {
  stageName: string;
  peakCCV: number;
  avgCCV: number;
  totalViewedHours: number;
  channelCount: number;
}

/** An annotation point on a time-series chart. */
export interface ChartAnnotation {
  timestamp: string;
  label: string;
}

/** A day separator line on multi-day time-series charts. */
export interface DaySeparator {
  timestamp: string;
  label: string;
}

// ── Option Types ────────────────────────────────────────────────────────────

export interface TimeSeriesChartOptions {
  title?: string;
  scopeLabel?: string;
  showPlatformOverlay?: boolean;
  /** Per-platform time series data keyed by platform name. */
  platformData?: Record<string, TimeSeriesPoint[]>;
  annotations?: ChartAnnotation[];
  daySeparators?: DaySeparator[];
}

export interface StackedAreaOptions {
  title?: string;
  scopeLabel?: string;
}

export interface PlatformDonutOptions {
  title?: string;
  scopeLabel?: string;
}

export interface BreakdownBarOptions {
  title?: string;
  scopeLabel?: string;
  metric?: 'totalCCV' | 'avgCCV' | 'peakCCV';
}

export interface LeaderboardOptions {
  title?: string;
  scopeLabel?: string;
  metric?: 'peakCCV' | 'avgCCV' | 'totalViewedMinutes';
  maxChannels?: number;
}

export interface DayOverDayOptions {
  title?: string;
  scopeLabel?: string;
}

export interface StageComparisonOptions {
  title?: string;
  scopeLabel?: string;
}

// ── Python Result ───────────────────────────────────────────────────────────

interface PythonResult {
  status: 'ok' | 'error';
  path?: string;
  error?: string;
}

// ── ChartGenerator Class ────────────────────────────────────────────────────

export class ChartGenerator {
  private readonly reportId: string;
  private readonly outputDir: string;

  constructor(reportId?: string) {
    this.reportId = reportId ?? uuidv4();
    this.outputDir = path.join(os.tmpdir(), 'charts', this.reportId);
  }

  /** The directory where chart PNGs are written. */
  get chartsDir(): string {
    return this.outputDir;
  }

  /** Unique report identifier for this generator instance. */
  get id(): string {
    return this.reportId;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Total CCV over time line chart with optional platform overlay,
   * annotations, and day separators.
   */
  async generateTimeSeriesChart(
    data: TimeSeriesPoint[],
    options: TimeSeriesChartOptions = {},
  ): Promise<string> {
    return this.runChart('time_series.py', 'time_series.png', data, options);
  }

  /** Stacked area chart of CCV by language over time. */
  async generateStackedAreaByLanguage(
    data: GroupedTimeSeriesPoint[],
    options: StackedAreaOptions = {},
  ): Promise<string> {
    return this.runChart('stacked_area_language.py', 'stacked_language.png', data, {
      title: 'CCV by Language',
      ...options,
    });
  }

  /** Stacked area chart of CCV by region over time. */
  async generateStackedAreaByRegion(
    data: GroupedTimeSeriesPoint[],
    options: StackedAreaOptions = {},
  ): Promise<string> {
    return this.runChart('stacked_area_region.py', 'stacked_region.png', data, {
      title: 'CCV by Region',
      ...options,
    });
  }

  /** Donut chart with platform brand colors, CCV, and percentages. */
  async generatePlatformDonut(
    data: PlatformBreakdown[],
    options: PlatformDonutOptions = {},
  ): Promise<string> {
    return this.runChart('platform_donut.py', 'platform_donut.png', data, {
      title: 'Platform Distribution',
      ...options,
    });
  }

  /** Horizontal bar chart of CCV by language, sorted descending. */
  async generateLanguageBars(
    data: LanguageBreakdown[],
    options: BreakdownBarOptions = {},
  ): Promise<string> {
    return this.runChart('language_bars.py', 'language_bars.png', data, {
      title: 'Language Distribution',
      ...options,
    });
  }

  /** Horizontal bar chart of CCV by region, sorted descending. */
  async generateRegionBars(
    data: RegionBreakdown[],
    options: BreakdownBarOptions = {},
  ): Promise<string> {
    return this.runChart('region_bars.py', 'region_bars.png', data, {
      title: 'Region Distribution',
      ...options,
    });
  }

  /**
   * Horizontal bar chart of top channels by peak CCV or viewed hours.
   * Color-coded by platform.
   */
  async generateChannelLeaderboard(
    data: ChannelLeaderboardEntry[],
    options: LeaderboardOptions = {},
  ): Promise<string> {
    return this.runChart('channel_leaderboard.py', 'channel_leaderboard.png', data, {
      title: 'Channel Leaderboard',
      ...options,
    });
  }

  /**
   * Grouped bar chart showing peak CCV and avg CCV per broadcast day.
   * Only used in stage/series scope reports.
   */
  async generateDayOverDayTrend(
    data: DayMetrics[],
    options: DayOverDayOptions = {},
  ): Promise<string> {
    return this.runChart('day_over_day.py', 'day_over_day.png', data, {
      title: 'Day-over-Day Trend',
      ...options,
    });
  }

  /**
   * Side-by-side bars comparing each stage's aggregate metrics.
   * Only used in series scope reports.
   */
  async generateStageComparison(
    data: StageMetrics[],
    options: StageComparisonOptions = {},
  ): Promise<string> {
    return this.runChart('stage_comparison.py', 'stage_comparison.png', data, {
      title: 'Stage Comparison',
      ...options,
    });
  }

  /**
   * Generate all charts for a complete report in parallel.
   * Returns a map of chart name → file path.
   */
  async generateAll(params: {
    timeSeries?: { data: TimeSeriesPoint[]; options?: TimeSeriesChartOptions };
    stackedLanguage?: { data: GroupedTimeSeriesPoint[]; options?: StackedAreaOptions };
    stackedRegion?: { data: GroupedTimeSeriesPoint[]; options?: StackedAreaOptions };
    platformDonut?: { data: PlatformBreakdown[]; options?: PlatformDonutOptions };
    languageBars?: { data: LanguageBreakdown[]; options?: BreakdownBarOptions };
    regionBars?: { data: RegionBreakdown[]; options?: BreakdownBarOptions };
    channelLeaderboard?: { data: ChannelLeaderboardEntry[]; options?: LeaderboardOptions };
    dayOverDay?: { data: DayMetrics[]; options?: DayOverDayOptions };
    stageComparison?: { data: StageMetrics[]; options?: StageComparisonOptions };
  }): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    const tasks: Array<Promise<void>> = [];

    if (params.timeSeries) {
      tasks.push(
        this.generateTimeSeriesChart(params.timeSeries.data, params.timeSeries.options)
          .then((p) => { results['timeSeries'] = p; }),
      );
    }
    if (params.stackedLanguage) {
      tasks.push(
        this.generateStackedAreaByLanguage(params.stackedLanguage.data, params.stackedLanguage.options)
          .then((p) => { results['stackedLanguage'] = p; }),
      );
    }
    if (params.stackedRegion) {
      tasks.push(
        this.generateStackedAreaByRegion(params.stackedRegion.data, params.stackedRegion.options)
          .then((p) => { results['stackedRegion'] = p; }),
      );
    }
    if (params.platformDonut) {
      tasks.push(
        this.generatePlatformDonut(params.platformDonut.data, params.platformDonut.options)
          .then((p) => { results['platformDonut'] = p; }),
      );
    }
    if (params.languageBars) {
      tasks.push(
        this.generateLanguageBars(params.languageBars.data, params.languageBars.options)
          .then((p) => { results['languageBars'] = p; }),
      );
    }
    if (params.regionBars) {
      tasks.push(
        this.generateRegionBars(params.regionBars.data, params.regionBars.options)
          .then((p) => { results['regionBars'] = p; }),
      );
    }
    if (params.channelLeaderboard) {
      tasks.push(
        this.generateChannelLeaderboard(params.channelLeaderboard.data, params.channelLeaderboard.options)
          .then((p) => { results['channelLeaderboard'] = p; }),
      );
    }
    if (params.dayOverDay) {
      tasks.push(
        this.generateDayOverDayTrend(params.dayOverDay.data, params.dayOverDay.options)
          .then((p) => { results['dayOverDay'] = p; }),
      );
    }
    if (params.stageComparison) {
      tasks.push(
        this.generateStageComparison(params.stageComparison.data, params.stageComparison.options)
          .then((p) => { results['stageComparison'] = p; }),
      );
    }

    await Promise.all(tasks);
    return results;
  }

  /** Remove all generated chart files for this report. */
  async cleanup(): Promise<void> {
    try {
      await rm(this.outputDir, { recursive: true, force: true });
      logger.debug('Chart cleanup complete', { reportId: this.reportId });
    } catch (err) {
      logger.warn('Chart cleanup failed', {
        reportId: this.reportId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /** Ensure the output directory exists. */
  private async ensureOutputDir(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }

  /**
   * Run a Python chart script with the given data, returning the output PNG path.
   *
   * @param script  - Name of the Python file in ./charts/
   * @param outFile - Name of the output PNG file
   * @param data    - Array of data points to chart
   * @param options - Chart-specific options
   */
  private async runChart<T extends object>(
    script: string,
    outFile: string,
    data: unknown[],
    options: T,
  ): Promise<string> {
    await this.ensureOutputDir();

    const scriptPath = path.join(CHARTS_DIR, script);
    const outputPath = path.join(this.outputDir, outFile);

    const payload = JSON.stringify({
      data,
      options,
      outputPath,
      configPath: CONFIG_PATH,
    });

    logger.debug('Generating chart', {
      script,
      outputPath,
      dataPoints: data.length,
      reportId: this.reportId,
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
        logger.error('Chart process spawn error', {
          script,
          error: err.message,
          duration,
          reportId: this.reportId,
        });
        reject(new ChartGenerationError(
          `Failed to spawn chart process: ${err.message}`,
          script,
        ));
      });

      proc.on('close', (code) => {
        const duration = Date.now() - startMs;

        if (code !== 0) {
          logger.error('Chart script failed', {
            script,
            exitCode: code,
            stderr: stderr.slice(0, 2000),
            duration,
            reportId: this.reportId,
          });
          reject(new ChartGenerationError(
            `Chart script exited with code ${code ?? 'null'}: ${stderr.slice(0, 500)}`,
            script,
          ));
          return;
        }

        // Parse JSON result from stdout
        try {
          const result: PythonResult = JSON.parse(stdout.trim());
          if (result.status === 'ok' && result.path) {
            logger.info('Chart generated', {
              script,
              outputPath: result.path,
              duration,
              reportId: this.reportId,
            });
            resolve(result.path);
          } else {
            reject(new ChartGenerationError(
              `Chart script returned error: ${result.error ?? 'unknown'}`,
              script,
            ));
          }
        } catch {
          // If JSON parse fails but file might exist, check the file
          this.fileExists(outputPath)
            .then((exists) => {
              if (exists) {
                logger.info('Chart generated (non-JSON output)', {
                  script,
                  outputPath,
                  duration,
                  reportId: this.reportId,
                });
                resolve(outputPath);
              } else {
                reject(new ChartGenerationError(
                  `Chart script produced invalid output: ${stdout.slice(0, 200)}`,
                  script,
                ));
              }
            })
            .catch(() => {
              reject(new ChartGenerationError(
                `Chart script produced invalid output: ${stdout.slice(0, 200)}`,
                script,
              ));
            });
        }
      });

      // Write the JSON payload to stdin
      proc.stdin.write(payload);
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

export class ChartGenerationError extends Error {
  readonly script: string;

  constructor(message: string, script: string) {
    super(message);
    this.name = 'ChartGenerationError';
    this.script = script;
  }
}
