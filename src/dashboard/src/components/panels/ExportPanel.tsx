import { useState, useMemo, useCallback, useEffect } from 'react';
import { Card, Button, FormField } from '@/components/common';
import { Select } from '@/components/common/Select';
import { useMutation } from '@/hooks/useMutation';
import * as api from '@/services/api';
import { formatTimeAgo, formatDate } from '@/utils/formatters';
import type { SeriesWithStages, ScopeLevel, ReportPayload } from '@/types/api';
import type { ReportPayloadQuery } from '@/services/api';

interface ExportPanelProps {
  seriesId: string;
  seriesDetail: SeriesWithStages | null;
}

interface ExportRecord {
  id: string;
  timestamp: string;
  scope: string;
  entityLabel: string;
  format: string;
  url?: string;
  publicUrl?: string;
}

const SCOPE_OPTIONS = [
  { value: 'series', label: 'Series' },
  { value: 'stage', label: 'Stage' },
  { value: 'day', label: 'Broadcast Day' },
];

const FORMAT_OPTIONS = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'html', label: 'HTML Report' },
  { value: 'report', label: 'Report (PDF-ready)' },
];

export function ExportPanel({ seriesId, seriesDetail }: ExportPanelProps) {
  const [scope, setScope] = useState<ScopeLevel>('series');
  const [entityId, setEntityId] = useState<string>(seriesId);
  const [format, setFormat] = useState<'csv' | 'json' | 'html' | 'report'>('csv');
  const [detail, setDetail] = useState<'simple' | 'detailed'>('simple');
  const [htmlLoading, setHtmlLoading] = useState(false);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  const [recentExports, setRecentExports] = useState<ExportRecord[]>([]);
  const [reportData, setReportData] = useState<ReportPayload | null>(null);
  const [publicReportUrl, setPublicReportUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset "Copied!" feedback after 2 seconds
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // Build entity options based on scope
  const entityOptions = useMemo(() => {
    if (!seriesDetail) return [];

    if (scope === 'series') {
      return [{ value: seriesId, label: seriesDetail.name }];
    }

    if (scope === 'stage') {
      return seriesDetail.stages.map((s) => ({
        value: s.id,
        label: s.name,
      }));
    }

    // scope === 'day'
    const days: { value: string; label: string }[] = [];
    for (const stage of seriesDetail.stages) {
      for (const day of stage.broadcast_days) {
        days.push({
          value: day.id,
          label: `${stage.name} > ${day.label} (${formatDate(day.date)})`,
        });
      }
    }
    return days;
  }, [scope, seriesId, seriesDetail]);

  // Auto-select first entity when scope changes
  const handleScopeChange = useCallback(
    (newScope: ScopeLevel) => {
      setScope(newScope);
      setReportData(null);
      if (newScope === 'series') {
        setEntityId(seriesId);
      } else {
        // Reset entity - will be set by next render
        setEntityId('');
      }
    },
    [seriesId],
  );

  // Report mutation
  const fetchReport = useCallback(
    (query: ReportPayloadQuery) => api.getReportPayload(query),
    [],
  );
  const { mutate: generateReport, loading: reportLoading, error: reportError } =
    useMutation<ReportPayload, [ReportPayloadQuery]>(fetchReport);

  const getEntityLabel = useCallback(() => {
    const found = entityOptions.find((o) => o.value === entityId);
    return found?.label ?? entityId;
  }, [entityOptions, entityId]);

  const addExportRecord = useCallback(
    (fmt: string, url?: string, publicUrl?: string) => {
      setRecentExports((prev) => [
        {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          scope,
          entityLabel: getEntityLabel(),
          format: fmt,
          url,
          publicUrl,
        },
        ...prev,
      ]);
    },
    [scope, getEntityLabel],
  );

  const handleExport = async () => {
    if (!entityId) return;

    if (format === 'csv' || format === 'json') {
      const url =
        format === 'csv'
          ? api.getExportCsvUrl(scope, entityId)
          : api.getExportJsonUrl(scope, entityId);

      // Trigger browser download
      const a = document.createElement('a');
      a.href = url;
      a.download = `clutch-export-${scope}-${entityId.slice(0, 8)}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      addExportRecord(format.toUpperCase(), url);
    } else if (format === 'html') {
      // HTML Report — generate and open in new tab
      setHtmlLoading(true);
      setHtmlError(null);
      setPublicReportUrl(null);
      try {
        const result = await api.generateReport({
          scope,
          id: entityId,
          format: 'html',
          skipNarratives: false,
          detail,
        });
        const reportUrl = api.getReportUrl(result.filePath);
        window.open(reportUrl, '_blank', 'noopener,noreferrer');

        // Build public URL if the series is public
        let pubUrl: string | undefined;
        if (seriesDetail?.is_public && seriesDetail?.short_name?.trim()) {
          const filename = result.filePath.split('/').pop() ?? '';
          if (filename) {
            pubUrl = api.getPublicReportUrl(seriesDetail.short_name, filename);
            setPublicReportUrl(pubUrl);
          }
        }

        addExportRecord('HTML', reportUrl, pubUrl);
      } catch (err) {
        setHtmlError(err instanceof api.ApiError ? err.message : (err as Error).message);
      } finally {
        setHtmlLoading(false);
      }
    } else {
      // Report (PDF-ready payload)
      const result = await generateReport({ scope, id: entityId });
      if (result) {
        setReportData(result);
        addExportRecord('Report');
      }
    }
  };

  return (
    <Card title="Export Data" subtitle="Download viewership data or generate reports" collapsible storageKey="cvt:panel:export">
      <div className="space-y-4">
        {/* Selectors row */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Scope">
            <Select
              options={SCOPE_OPTIONS}
              value={scope}
              onChange={(e) => handleScopeChange(e.target.value as ScopeLevel)}
            />
          </FormField>

          <FormField label="Entity">
            <Select
              options={entityOptions}
              value={entityId}
              onChange={(e) => {
                setEntityId(e.target.value);
                setReportData(null);
              }}
              placeholder={entityOptions.length === 0 ? 'No options' : 'Select...'}
              disabled={entityOptions.length === 0}
            />
          </FormField>

          <FormField label="Format">
            <Select
              options={FORMAT_OPTIONS}
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as 'csv' | 'json' | 'html' | 'report');
                setReportData(null);
                setHtmlError(null);
              }}
            />
          </FormField>
        </div>

        {/* Detail level toggle — shown for report formats */}
        {(format === 'html' || format === 'report') && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">Detail Level:</span>
            <div className="flex rounded-md bg-navy-800 p-0.5">
              {(['simple', 'detailed'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDetail(d)}
                  className={`rounded px-3 py-1 text-xs font-medium capitalize transition-colors ${
                    detail === d
                      ? 'bg-clutch-red text-white'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-gray-600">
              {detail === 'detailed' ? 'All channels included' : 'Top channels only'}
            </span>
          </div>
        )}

        {/* Export button */}
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            onClick={handleExport}
            loading={reportLoading || htmlLoading}
            disabled={!entityId}
          >
            {format === 'html'
              ? 'Generate HTML Report'
              : format === 'report'
                ? 'Generate Report'
                : `Export ${format.toUpperCase()}`}
          </Button>

          {(reportError || htmlError) && (
            <span className="text-xs text-accent-red">{reportError || htmlError}</span>
          )}
        </div>

        {/* Public report URL */}
        {publicReportUrl && (
          <div className="rounded-lg border border-navy-700/50 bg-navy-800/60 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <svg className="h-4 w-4 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                <path d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" />
              </svg>
              <span className="text-xs font-medium text-gray-300">Public Report Link</span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={publicReportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate rounded bg-navy-900/60 px-2 py-1 font-mono text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                title={publicReportUrl}
              >
                {publicReportUrl}
              </a>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(publicReportUrl);
                  setCopied(true);
                }}
                className="shrink-0 rounded bg-navy-700 px-2.5 py-1 text-[11px] font-medium text-gray-300 hover:bg-navy-600 hover:text-white transition-colors"
                title="Copy public URL"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-gray-600">
              Share this link with external parties &mdash; no login required.
            </p>
          </div>
        )}

        {/* Report preview */}
        {reportData && (
          <div className="rounded-lg border border-navy-700/50 bg-navy-800/60 p-4">
            <div className="mb-2 flex items-center gap-2">
              <svg className="h-4 w-4 text-accent-green" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-sm font-medium text-gray-200">Report Generated</span>
            </div>
            <div className="space-y-1 text-xs text-gray-400">
              <p>
                <span className="text-gray-500">Series:</span>{' '}
                {reportData.series.name}
              </p>
              <p>
                <span className="text-gray-500">Generated:</span>{' '}
                {formatDate(reportData.generatedAt)}
              </p>
              <p>
                <span className="text-gray-500">Snapshots:</span>{' '}
                {reportData.snapshotCount.toLocaleString()}
              </p>
              <p>
                <span className="text-gray-500">Stages:</span>{' '}
                {reportData.stages.length}
              </p>
              <p>
                <span className="text-gray-500">Broadcast Days:</span>{' '}
                {reportData.broadcastDays.length}
              </p>
            </div>
            <p className="mt-2 text-[11px] text-gray-600">
              Use your browser&apos;s Print function (Ctrl+P / Cmd+P) to save as PDF.
            </p>
          </div>
        )}

        {/* Recent exports */}
        {recentExports.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-medium text-gray-500">Recent Exports</h4>
            <div className="space-y-1">
              {recentExports.slice(0, 5).map((exp) => (
                <div
                  key={exp.id}
                  className="flex items-center justify-between rounded-lg bg-navy-800/40 px-3 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2 text-gray-400">
                    <span className="font-mono text-[10px] text-gray-600">
                      {formatTimeAgo(exp.timestamp)}
                    </span>
                    <span>{exp.scope}</span>
                    <span className="text-gray-600">/</span>
                    <span className="truncate max-w-[150px]">{exp.entityLabel}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-navy-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
                      {exp.format}
                    </span>
                    {exp.publicUrl && (
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(exp.publicUrl!);
                          setCopied(true);
                        }}
                        title="Copy public link"
                        className="text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" />
                        </svg>
                      </button>
                    )}
                    {exp.url && (
                      <a
                        href={exp.url}
                        download
                        className="text-clutch-red hover:text-[#ff4070] transition-colors"
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                          <path
                            fillRule="evenodd"
                            d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
