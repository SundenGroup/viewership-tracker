// Chart generation service
export { ChartGenerator, ChartGenerationError } from './chart-generator';
export type {
  TimeSeriesPoint,
  GroupedTimeSeriesPoint,
  PlatformBreakdown,
  LanguageBreakdown,
  RegionBreakdown,
  ChannelLeaderboardEntry,
  DayMetrics,
  StageMetrics,
  ChartAnnotation,
  DaySeparator,
  TimeSeriesChartOptions,
  StackedAreaOptions,
  PlatformDonutOptions,
  BreakdownBarOptions,
  LeaderboardOptions,
  DayOverDayOptions,
  StageComparisonOptions,
} from './chart-generator';

// Report document builder
export { ReportBuilder, ReportBuildError } from './report-builder';
export type {
  BrandingConfig,
  ReportPayload,
  ChartPaths,
  Narratives,
  BuildReportOptions,
  TimeSeriesDataPoint,
  SnapshotRow,
} from './report-builder';

// Report agent orchestrator
export { ReportAgent, ReportAgentError } from './report-agent';
export type {
  ReportScope,
  ReportTemplate,
  DeliveryMethod,
  ReportRequest,
  ExportRequest,
  ReportResult,
  AutoReportConfig,
  ReportGeneratedFn,
} from './report-agent';
