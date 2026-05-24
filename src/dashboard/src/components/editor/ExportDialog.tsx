/**
 * ExportDialog — v7 export modal.
 *
 * Replaces the legacy direct-download Export button with a proper dialog
 * that lets operators choose:
 *   - Format: CSV / JSON / HTML
 *   - Scope: Current view / Entire series / Stage / Day
 *   - HTML-only: re-render fresh vs. download latest cached report
 *
 * After an HTML download, if the series is public, the public report URL
 * is shown inline with a copy-to-clipboard button (parity with the legacy
 * ExportPanel public-link feature).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from '@/services/api';
import { Row, Col, IconX, IconDownload, IconShare } from '@/components/design';
import type { SeriesWithStages, ScopeLevel, ViewGroup } from '@/types/api';

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  seriesDetail: SeriesWithStages | null;
  /** Currently-active scope (from the scrubber). */
  activeScope: {
    level: ScopeLevel;
    stageId?: string | null;
    dayId?: string | null;
  };
  /** Current view-group name, if any. */
  activeViewGroupName?: string | null;
  /** Available view groups on the series. */
  viewGroups: ViewGroup[];
}

type ExportFormat = 'csv' | 'json' | 'html';

const FORMAT_TILES: Array<{
  id: ExportFormat;
  label: string;
  sub: string;
}> = [
  { id: 'csv', label: 'CSV', sub: 'Tabular export · per-channel rows' },
  { id: 'json', label: 'JSON', sub: 'Raw DB export, integrations' },
  { id: 'html', label: 'HTML', sub: 'Static report — trigger render job' },
];

type ScopeChoice = 'current' | 'series' | 'stage' | 'multi_stage' | 'day';

type ResolvedTarget =
  | { kind: 'single'; scopeLevel: ScopeLevel; id: string }
  | { kind: 'multi_stage'; ids: string[] };

export function ExportDialog({
  open,
  onClose,
  seriesId,
  seriesDetail,
  activeScope,
  activeViewGroupName,
  viewGroups,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [scope, setScope] = useState<ScopeChoice>('current');
  const [selectedStageIds, setSelectedStageIds] = useState<string[]>([]);
  const [reRender, setReRender] = useState(false);
  const [detail, setDetail] = useState<'simple' | 'detailed'>('simple');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicLink, setPublicLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Local override for the active view group inside the dialog. Initialised
  // from the parent prop on open, but the user can switch without closing
  // the dialog or touching the top-bar picker.
  const [viewGroupOverride, setViewGroupOverride] = useState<string | null>(
    activeViewGroupName ?? null,
  );
  const effectiveViewGroupName = viewGroupOverride;
  // Channel-exclusion picker (ported from the legacy ExportPanel). Drops
  // specific channels from the export's aggregation. Applies to BOTH
  // renderers: the legacy server-rendered HTML (via excludeChannelIds in
  // generateReport) and the live SPA report (via ?exclude= on the URL).
  const [excludeChannelIds, setExcludeChannelIds] = useState<string[]>([]);
  const [allChannels, setAllChannels] = useState<
    Array<{ id: string; display_name: string; platform: string }>
  >([]);
  const [channelSearch, setChannelSearch] = useState('');

  // Reset copied indicator
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // Reset state whenever the dialog opens. Re-seed the view-group override
  // from the parent so the dialog always opens on the operator's current
  // selection but they're free to switch from inside.
  useEffect(() => {
    if (open) {
      setError(null);
      setPublicLink(null);
      setBusy(false);
      setScope('current');
      setSelectedStageIds([]);
      setReRender(false);
      setViewGroupOverride(activeViewGroupName ?? null);
      setExcludeChannelIds([]);
      setChannelSearch('');
    }
  }, [open, activeViewGroupName]);

  // Load the series' active channels for the exclusion picker when the
  // dialog opens. Cheap, cached by the browser; only fetched while open.
  useEffect(() => {
    if (!open || !seriesId) return;
    api
      .listChannels(seriesId, { is_active: 'true' })
      .then((rows) =>
        setAllChannels(
          rows.map((c) => ({
            id: c.id,
            display_name: c.display_name,
            platform: c.platform,
          })),
        ),
      )
      .catch(() => setAllChannels([]));
  }, [open, seriesId]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Current day based on activeScope
  const currentDay = useMemo(() => {
    if (!seriesDetail || !activeScope.dayId) return null;
    for (const s of seriesDetail.stages) {
      const d = s.broadcast_days.find((d) => d.id === activeScope.dayId);
      if (d) return { ...d, stageName: s.name, stageId: s.id };
    }
    return null;
  }, [seriesDetail, activeScope.dayId]);

  // Current stage:
  //   - When the top-bar scrubber is at STAGE level the user has explicitly
  //     picked a stage — honor it even if a day from a *different* stage is
  //     also remembered (e.g. sidebar still highlights yesterday's day).
  //   - Otherwise, when a specific day is in scope, the semantically "current
  //     stage" is that day's parent stage.
  //   - Fallback: whatever stageId activeScope carries.
  const currentStage = useMemo(() => {
    if (!seriesDetail) return null;
    if (activeScope.level === 'stage' && activeScope.stageId) {
      return (
        seriesDetail.stages.find((s) => s.id === activeScope.stageId) ?? null
      );
    }
    if (currentDay?.stageId) {
      return (
        seriesDetail.stages.find((s) => s.id === currentDay.stageId) ?? null
      );
    }
    if (activeScope.stageId) {
      return (
        seriesDetail.stages.find((s) => s.id === activeScope.stageId) ?? null
      );
    }
    return null;
  }, [seriesDetail, activeScope.level, activeScope.stageId, currentDay?.stageId]);

  // Human-readable scope labels
  const scopeLabelCurrent =
    activeScope.level === 'day' && currentDay
      ? `${currentDay.stageName} · ${currentDay.label}`
      : activeScope.level === 'stage' && currentStage
        ? currentStage.name
        : seriesDetail?.name ?? 'Series';

  const viewGroupLabel = effectiveViewGroupName ?? 'All channels';

  // Resolve the scope target for the backend export endpoints. Returns
  // either a single (scope, id) pair or a multi_stage list of stage ids.
  const resolveTarget = (): ResolvedTarget => {
    if (scope === 'current') {
      return {
        kind: 'single',
        scopeLevel: activeScope.level,
        id:
          activeScope.level === 'day' && activeScope.dayId
            ? activeScope.dayId
            : activeScope.level === 'stage' && activeScope.stageId
              ? activeScope.stageId
              : seriesId,
      };
    }
    if (scope === 'series') return { kind: 'single', scopeLevel: 'series', id: seriesId };
    if (scope === 'stage' && currentStage)
      return { kind: 'single', scopeLevel: 'stage', id: currentStage.id };
    if (scope === 'multi_stage' && selectedStageIds.length >= 2)
      return { kind: 'multi_stage', ids: selectedStageIds };
    if (scope === 'day' && currentDay)
      return { kind: 'single', scopeLevel: 'day', id: currentDay.id };
    // Fallbacks when nothing resolvable
    return { kind: 'single', scopeLevel: 'series', id: seriesId };
  };

  // Stages selected for multi-stage export, ordered by stage.order so the
  // displayed and exported order is stable.
  const orderedSelectedStages = useMemo(() => {
    if (!seriesDetail) return [];
    return seriesDetail.stages
      .filter((s) => selectedStageIds.includes(s.id))
      .sort((a, b) => a.order - b.order);
  }, [seriesDetail, selectedStageIds]);

  const toggleStageId = (id: string) => {
    setSelectedStageIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  // Append ?view=<name> and/or ?exclude=<ids> so the SPA ReportPage can
  // replay the dialog's view-group + channel-exclusion selections. Returns
  // the path unchanged when neither is set. Uses effectiveViewGroupName so
  // the in-dialog picker override wins over the top-bar selection.
  const withViewParam = (path: string): string => {
    let out = path;
    const addParam = (k: string, v: string) => {
      const sep = out.includes('?') ? '&' : '?';
      out = `${out}${sep}${k}=${v}`;
    };
    const groupName = effectiveViewGroupName?.trim();
    if (groupName) addParam('view', encodeURIComponent(groupName));
    if (excludeChannelIds.length) addParam('exclude', excludeChannelIds.map(encodeURIComponent).join(','));
    return out;
  };

  // File name / target preview (mono caption in footer).
  // For HTML "new design" mode this is a URL; otherwise a filename.
  const fileName = useMemo(() => {
    const target = resolveTarget();
    if (format === 'html' && !reRender) {
      const shortName = seriesDetail?.short_name?.trim();
      if (!shortName) return 'needs short_name';
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      if (target.kind === 'multi_stage') {
        const orders = orderedSelectedStages.map((s) => s.order).join(',');
        return withViewParam(`${base}/public/${shortName}/report/${detail}?stages=${orders}`);
      }
      const { scopeLevel, id } = target;
      let slug = '';
      if (scopeLevel === 'day') {
        const day = seriesDetail?.stages
          .flatMap((s) => s.broadcast_days)
          .find((d) => d.id === id);
        const date = day?.date ? String(day.date).slice(0, 10) : '';
        slug = date || `${id.slice(0, 6)}…`;
      } else if (scopeLevel === 'stage') {
        const stage = seriesDetail?.stages.find((s) => s.id === id);
        slug = stage ? `stage-${stage.order}` : `${id.slice(0, 6)}…`;
      }
      return withViewParam(`${base}/public/${shortName}/report/${detail}${slug ? `/${slug}` : ''}`);
    }
    const slugBase =
      seriesDetail?.short_name?.trim() || seriesDetail?.name || 'series';
    const slug = slugBase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (target.kind === 'multi_stage') {
      const orders = orderedSelectedStages.map((s) => s.order).join('-');
      return `${slug}_stages-${orders || target.ids.length + 'stages'}.${format}`;
    }
    const { scopeLevel, id } = target;
    const suffix =
      scopeLevel === 'series'
        ? 'full-series'
        : scopeLevel === 'stage'
          ? `stage-${id.slice(0, 6)}`
          : `day-${id.slice(0, 6)}`;
    return `${slug}_${suffix}.${format}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    seriesDetail,
    format,
    scope,
    activeScope,
    currentStage,
    currentDay,
    seriesId,
    detail,
    reRender,
    orderedSelectedStages,
    selectedStageIds,
  ]);

  const resolvedViewGroup = useMemo(() => {
    if (!effectiveViewGroupName) return null;
    return viewGroups.find((g) => g.name === effectiveViewGroupName) ?? null;
  }, [effectiveViewGroupName, viewGroups]);

  // Build the preview ReportPage URL for a given scope + detail level.
  // The SPA renders the v6+ redesign live from the API — no server-side
  // template involved, always fresh against the DB.
  //
  // URL format:
  //   Series:        /public/<short>/report/<variant>
  //   Stage:         /public/<short>/report/<variant>/stage-<order>
  //   Day:           /public/<short>/report/<variant>/<YYYY-MM-DD>
  //   Multi-stage:   /public/<short>/report/<variant>?stages=<order1>,<order2>
  // Falls back to the raw UUID slug if we can't resolve the friendlier form.
  const buildSpaReportUrl = (): string | null => {
    const shortName = seriesDetail?.short_name?.trim();
    if (!shortName) return null;
    const target = resolveTarget();
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    if (target.kind === 'multi_stage') {
      const orders = orderedSelectedStages.map((s) => s.order).join(',');
      const path = withViewParam(
        `${base}/public/${shortName}/report/${detail}?stages=${orders}`,
      );
      return `${window.location.origin}${path}`;
    }
    const { scopeLevel, id } = target;
    let slug = '';
    if (scopeLevel === 'day') {
      const day = seriesDetail?.stages
        .flatMap((s) => s.broadcast_days)
        .find((d) => d.id === id);
      const date = day?.date ? String(day.date).slice(0, 10) : '';
      slug = date || id;
    } else if (scopeLevel === 'stage') {
      const stage = seriesDetail?.stages.find((s) => s.id === id);
      slug = stage ? `stage-${stage.order}` : id;
    }
    const path = withViewParam(
      `${base}/public/${shortName}/report/${detail}${slug ? `/${slug}` : ''}`,
    );
    return `${window.location.origin}${path}`;
  };

  const handleDownload = async () => {
    if (busy) return;
    setError(null);
    setPublicLink(null);
    const target = resolveTarget();

    try {
      if (format === 'csv' || format === 'json') {
        const url =
          target.kind === 'multi_stage'
            ? format === 'csv'
              ? api.getExportCsvUrlMulti(target.ids)
              : api.getExportJsonUrlMulti(target.ids)
            : format === 'csv'
              ? api.getExportCsvUrl(target.scopeLevel, target.id)
              : api.getExportJsonUrl(target.scopeLevel, target.id);
        window.open(url, '_blank', 'noopener,noreferrer');
        onClose();
        return;
      }

      // HTML
      if (reRender) {
        // Legacy server-generated static HTML (old design, archival).
        setBusy(true);
        const result = await api.generateReport({
          ...(target.kind === 'multi_stage'
            ? { scope: 'multi_stage' as const, ids: target.ids }
            : { scope: target.scopeLevel, id: target.id }),
          format: 'html',
          skipNarratives: false,
          detail,
          viewGroup: resolvedViewGroup
            ? {
                name: resolvedViewGroup.name,
                languages: resolvedViewGroup.languages,
                platforms: resolvedViewGroup.platforms,
              }
            : undefined,
          excludeChannelIds: excludeChannelIds.length ? excludeChannelIds : undefined,
        });
        const reportUrl = api.getReportUrl(result.filePath);
        window.open(reportUrl, '_blank', 'noopener,noreferrer');

        const pub =
          seriesDetail?.is_public && seriesDetail?.short_name?.trim()
            ? api.getPublicReportUrl(
                seriesDetail.short_name,
                result.filePath.split('/').pop() ?? '',
              )
            : null;
        setPublicLink(pub);
      } else {
        // Preview default: open the redesigned ReportPage. It renders live
        // from the API, so it's always up-to-date and matches the v7 UI.
        const spaUrl = buildSpaReportUrl();
        if (!spaUrl) {
          setError(
            'This series has no short_name. Set a short_name in Edit Series before exporting an HTML report.',
          );
          return;
        }
        window.open(spaUrl, '_blank', 'noopener,noreferrer');
        // The SPA URL IS the public, shareable link — no generation step.
        if (seriesDetail?.is_public) setPublicLink(spaUrl);
      }
    } catch (err) {
      setError(
        err instanceof api.ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Export failed',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const scopeOptions: Array<{
    id: ScopeChoice;
    label: string;
    sub: string;
    disabled?: boolean;
  }> = [
    {
      id: 'current',
      label: `Current view — ${scopeLabelCurrent} · ${viewGroupLabel}`,
      sub: "What's shown on the dashboard right now",
    },
    {
      id: 'series',
      label: `Entire series — ${seriesDetail?.name ?? 'Series'}`,
      sub: 'All stages, all days, all channels',
    },
    {
      id: 'stage',
      label: currentStage
        ? `Stage — ${currentStage.name}`
        : 'Stage — (none selected)',
      sub: 'All days in the current stage',
      disabled: !currentStage,
    },
    {
      id: 'multi_stage',
      label:
        selectedStageIds.length === 0
          ? 'Multiple stages — pick from list'
          : `Multiple stages — ${selectedStageIds.length} selected`,
      sub: 'Combine 2+ stages into one export (flattened aggregation)',
      disabled: !seriesDetail || seriesDetail.stages.length < 2,
    },
    {
      id: 'day',
      label: currentDay
        ? `Day only — ${currentDay.label}`
        : 'Day only — (none selected)',
      sub: 'This broadcast day',
      disabled: !currentDay,
    },
  ];

  // For the action button: multi_stage requires at least 2 stages.
  const actionDisabled =
    busy || (scope === 'multi_stage' && selectedStageIds.length < 2);

  const publicDashUrl =
    seriesDetail?.is_public && seriesDetail?.short_name?.trim()
      ? `${window.location.origin}/public/${seriesDetail.short_name}`
      : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'color-mix(in oklab, var(--bg) 60%, rgba(0,0,0,0.55))',
        backdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: 640,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Header */}
        <Row
          justify="space-between"
          align="flex-start"
          style={{
            padding: '18px 22px 14px',
            borderBottom: '1px solid var(--border-faint)',
          }}
        >
          <Col gap={3} style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Export data</h3>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Scoped to your current view.
            </div>
          </Col>
          <button
            onClick={onClose}
            className="btn"
            style={{ padding: 5, background: 'transparent', border: 'none' }}
            title="Close"
          >
            <IconX size={12} />
          </button>
        </Row>

        {/* Body */}
        <div style={{ padding: '18px 22px', overflow: 'auto', flex: 1 }}>
          <Col gap={18}>
            {/* Scope + view group summary */}
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--bg-sunken)',
                border: '1px solid var(--border-faint)',
                borderRadius: 5,
                fontSize: 11.5,
              }}
            >
              <Row gap={8} style={{ color: 'var(--fg-muted)', flexWrap: 'wrap' }}>
                <span className="eyebrow" style={{ fontSize: 9.5 }}>
                  Scope
                </span>
                <span style={{ color: 'var(--fg)', fontWeight: 500 }}>
                  {scopeLabelCurrent}
                </span>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span className="eyebrow" style={{ fontSize: 9.5 }}>
                  View group
                </span>
                <span style={{ color: 'var(--fg)', fontWeight: 500 }}>
                  {viewGroupLabel}
                </span>
              </Row>
            </div>

            {/* View-group picker — only shown when the series defines at
                least one view group. "All channels" maps to no filter. */}
            {viewGroups.length > 0 && (
              <Field label="View group">
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                  }}
                >
                  {[
                    { name: null as string | null, label: 'All channels' },
                    ...viewGroups.map((g) => ({ name: g.name, label: g.name })),
                  ].map((opt) => {
                    const active = effectiveViewGroupName === opt.name;
                    return (
                      <button
                        key={opt.name ?? '__all__'}
                        type="button"
                        onClick={() => setViewGroupOverride(opt.name)}
                        style={{
                          padding: '5px 11px',
                          borderRadius: 999,
                          fontSize: 11.5,
                          fontWeight: active ? 600 : 500,
                          background: active
                            ? 'color-mix(in oklab, var(--red) 12%, var(--bg-card))'
                            : 'var(--bg-card)',
                          color: active ? 'var(--red)' : 'var(--fg)',
                          border:
                            '1px solid ' +
                            (active ? 'var(--red)' : 'var(--border)'),
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            {/* Exclude-channels picker — ported from the legacy ExportPanel.
                Drops the selected channels from the export's aggregation.
                Honored by both renderers (legacy HTML + live SPA report). */}
            {allChannels.length > 0 && (
              <Field
                label={`Exclude channels${excludeChannelIds.length ? ` (${excludeChannelIds.length})` : ''}`}
              >
                <input
                  type="text"
                  placeholder="Search channels…"
                  value={channelSearch}
                  onChange={(e) => setChannelSearch(e.target.value)}
                  style={{
                    width: '100%',
                    marginBottom: 8,
                    padding: '6px 9px',
                    fontSize: 12,
                    borderRadius: 5,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    color: 'var(--fg)',
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    maxHeight: 140,
                    overflowY: 'auto',
                  }}
                >
                  {allChannels
                    .filter((ch) =>
                      ch.display_name
                        .toLowerCase()
                        .includes(channelSearch.toLowerCase()),
                    )
                    .slice(0, 60)
                    .map((ch) => {
                      const active = excludeChannelIds.includes(ch.id);
                      return (
                        <button
                          key={ch.id}
                          type="button"
                          title={`${ch.platform} · ${ch.display_name}`}
                          onClick={() =>
                            setExcludeChannelIds((prev) =>
                              active
                                ? prev.filter((v) => v !== ch.id)
                                : [...prev, ch.id],
                            )
                          }
                          style={{
                            padding: '4px 10px',
                            borderRadius: 999,
                            fontSize: 11.5,
                            fontWeight: active ? 600 : 500,
                            background: active
                              ? 'color-mix(in oklab, var(--red) 14%, var(--bg-card))'
                              : 'var(--bg-card)',
                            color: active ? 'var(--red)' : 'var(--fg)',
                            border:
                              '1px solid ' +
                              (active ? 'var(--red)' : 'var(--border)'),
                            textDecoration: active ? 'line-through' : 'none',
                            cursor: 'pointer',
                          }}
                        >
                          {ch.display_name}
                        </button>
                      );
                    })}
                </div>
                {excludeChannelIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setExcludeChannelIds([])}
                    style={{
                      marginTop: 8,
                      fontSize: 10.5,
                      color: 'var(--fg-dim)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    Clear {excludeChannelIds.length} excluded
                  </button>
                )}
              </Field>
            )}

            {/* Format picker */}
            <Field label="Format">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 8,
                }}
              >
                {FORMAT_TILES.map((f) => {
                  const active = format === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFormat(f.id)}
                      style={{
                        textAlign: 'left',
                        padding: '11px 13px',
                        borderRadius: 6,
                        background: active
                          ? 'color-mix(in oklab, var(--red) 10%, var(--bg-card))'
                          : 'var(--bg-card)',
                        border:
                          '1px solid ' +
                          (active ? 'var(--red)' : 'var(--border)'),
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        color: 'var(--fg)',
                      }}
                    >
                      <Row gap={8}>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: active ? 'var(--red)' : 'var(--fg)',
                          }}
                        >
                          {f.label}
                        </span>
                        {active && (
                          <span style={{ fontSize: 10, color: 'var(--red)' }}>
                            ●
                          </span>
                        )}
                      </Row>
                      <span style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                        {f.sub}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Field>

            {/* Scope picker */}
            <Field label="Scope">
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {scopeOptions.map((o) => {
                  const active = scope === o.id;
                  return (
                    <label
                      key={o.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 5,
                        background: active ? 'var(--bg-sunken)' : 'transparent',
                        border:
                          '1px solid ' +
                          (active ? 'var(--border-strong)' : 'transparent'),
                        cursor: o.disabled ? 'not-allowed' : 'pointer',
                        opacity: o.disabled ? 0.45 : 1,
                      }}
                    >
                      <input
                        type="radio"
                        checked={active}
                        disabled={o.disabled}
                        onChange={() => !o.disabled && setScope(o.id)}
                        style={{ marginTop: 2, accentColor: 'var(--red)' }}
                      />
                      <Col gap={1} style={{ minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: active ? 600 : 500,
                          }}
                        >
                          {o.label}
                        </span>
                        <span style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                          {o.sub}
                        </span>
                      </Col>
                    </label>
                  );
                })}
              </div>

              {/* Stage checkbox list — visible only when Multiple stages is picked */}
              {scope === 'multi_stage' && seriesDetail && (
                <div
                  style={{
                    marginTop: 8,
                    padding: '10px 12px',
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-faint)',
                    borderRadius: 5,
                  }}
                >
                  <div
                    className="eyebrow"
                    style={{
                      fontSize: 9.5,
                      letterSpacing: 0.5,
                      marginBottom: 6,
                      color: 'var(--fg-muted)',
                    }}
                  >
                    Stages to include
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      maxHeight: 220,
                      overflowY: 'auto',
                    }}
                  >
                    {[...seriesDetail.stages]
                      .sort((a, b) => a.order - b.order)
                      .map((s) => {
                        const checked = selectedStageIds.includes(s.id);
                        return (
                          <label
                            key={s.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '5px 6px',
                              borderRadius: 4,
                              cursor: 'pointer',
                              background: checked
                                ? 'color-mix(in oklab, var(--red) 7%, transparent)'
                                : 'transparent',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleStageId(s.id)}
                              style={{ accentColor: 'var(--red)' }}
                            />
                            <span style={{ fontSize: 12 }}>{s.name}</span>
                            <span
                              className="mono"
                              style={{
                                fontSize: 10,
                                color: 'var(--fg-dim)',
                                marginLeft: 'auto',
                              }}
                            >
                              stage-{s.order}
                            </span>
                          </label>
                        );
                      })}
                  </div>
                  {selectedStageIds.length < 2 && (
                    <div
                      style={{
                        fontSize: 10.5,
                        color: 'var(--fg-dim)',
                        marginTop: 6,
                        paddingLeft: 2,
                      }}
                    >
                      Select at least 2 stages.
                    </div>
                  )}
                </div>
              )}
            </Field>

            {/* HTML-specific: detail + re-render */}
            {format === 'html' && (
              <>
                <Field label="Detail level">
                  <div
                    style={{
                      display: 'flex',
                      background: 'var(--bg-sunken)',
                      borderRadius: 6,
                      padding: 3,
                      border: '1px solid var(--border)',
                      width: 'fit-content',
                    }}
                  >
                    {(['simple', 'detailed'] as const).map((d) => {
                      const active = detail === d;
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDetail(d)}
                          style={{
                            padding: '5px 12px',
                            borderRadius: 4,
                            fontSize: 11.5,
                            fontWeight: 500,
                            background: active ? 'var(--red)' : 'transparent',
                            color: active ? 'white' : 'var(--fg-muted)',
                            border: 'none',
                            cursor: 'pointer',
                            textTransform: 'capitalize',
                          }}
                        >
                          {d}
                        </button>
                      );
                    })}
                    <span
                      style={{
                        alignSelf: 'center',
                        marginLeft: 10,
                        fontSize: 10.5,
                        color: 'var(--fg-dim)',
                      }}
                    >
                      {detail === 'detailed'
                        ? 'All channels included'
                        : 'Top channels only'}
                    </span>
                  </div>
                </Field>

                <Field label="Renderer">
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 5,
                        background: !reRender ? 'var(--bg-sunken)' : 'transparent',
                        border:
                          '1px solid ' +
                          (!reRender ? 'var(--border-strong)' : 'transparent'),
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="radio"
                        checked={!reRender}
                        onChange={() => setReRender(false)}
                        style={{ marginTop: 2, accentColor: 'var(--red)' }}
                      />
                      <Col gap={1} style={{ minWidth: 0 }}>
                        <Row gap={6}>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: !reRender ? 600 : 500,
                            }}
                          >
                            New design (live)
                          </span>
                          <span
                            className="mono"
                            style={{
                              fontSize: 9,
                              padding: '1px 5px',
                              borderRadius: 3,
                              background:
                                'color-mix(in oklab, var(--red) 12%, transparent)',
                              color: 'var(--red)',
                              letterSpacing: 0.3,
                            }}
                          >
                            PREVIEW
                          </span>
                        </Row>
                        <span
                          style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}
                        >
                          Opens the redesigned report in a new tab. Rendered
                          live against the API — always fresh, no waiting.
                        </span>
                      </Col>
                    </label>

                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 5,
                        background: reRender ? 'var(--bg-sunken)' : 'transparent',
                        border:
                          '1px solid ' +
                          (reRender ? 'var(--border-strong)' : 'transparent'),
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="radio"
                        checked={reRender}
                        onChange={() => setReRender(true)}
                        style={{ marginTop: 2, accentColor: 'var(--red)' }}
                      />
                      <Col gap={1} style={{ minWidth: 0 }}>
                        <Row gap={6}>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: reRender ? 600 : 500,
                            }}
                          >
                            Legacy static HTML
                          </span>
                          <span
                            className="mono"
                            style={{
                              fontSize: 9,
                              padding: '1px 5px',
                              borderRadius: 3,
                              background: 'var(--bg-card)',
                              color: 'var(--fg-dim)',
                              letterSpacing: 0.3,
                              border: '1px solid var(--border)',
                            }}
                          >
                            ARCHIVAL
                          </span>
                        </Row>
                        <span
                          style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}
                        >
                          Server-rendered HTML file (old design). Takes
                          10–40s. Useful for downloads / offline archives.
                        </span>
                      </Col>
                    </label>
                  </div>
                </Field>
              </>
            )}

            {/* Public dashboard link — always shown if series is public */}
            {publicDashUrl && (
              <div
                style={{
                  padding: '10px 12px',
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border-faint)',
                  borderRadius: 5,
                }}
              >
                <Row gap={8} style={{ marginBottom: 6 }}>
                  <IconShare size={12} />
                  <span
                    className="eyebrow"
                    style={{ fontSize: 9.5, letterSpacing: 0.5 }}
                  >
                    Public dashboard
                  </span>
                </Row>
                <Row gap={6}>
                  <a
                    href={publicDashUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: 11,
                      color: 'var(--red)',
                      textDecoration: 'none',
                      padding: '4px 8px',
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                    }}
                    title={publicDashUrl}
                  >
                    {publicDashUrl}
                  </a>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 11, padding: '4px 10px' }}
                    onClick={() => {
                      navigator.clipboard
                        .writeText(publicDashUrl)
                        .catch(() => {});
                      setCopied(true);
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </Row>
              </div>
            )}

            {/* Public report link — shown after HTML generation */}
            {publicLink && (
              <div
                style={{
                  padding: '10px 12px',
                  background:
                    'color-mix(in oklab, var(--info) 8%, transparent)',
                  border:
                    '1px solid color-mix(in oklab, var(--info) 30%, var(--border))',
                  borderRadius: 5,
                }}
              >
                <Row gap={8} style={{ marginBottom: 6 }}>
                  <IconShare size={12} />
                  <span
                    className="eyebrow"
                    style={{ fontSize: 9.5, letterSpacing: 0.5 }}
                  >
                    Public report link
                  </span>
                </Row>
                <Row gap={6}>
                  <a
                    href={publicLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: 11,
                      color: 'var(--info)',
                      textDecoration: 'none',
                      padding: '4px 8px',
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                    }}
                    title={publicLink}
                  >
                    {publicLink}
                  </a>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 11, padding: '4px 10px' }}
                    onClick={() => {
                      navigator.clipboard.writeText(publicLink).catch(() => {});
                      setCopied(true);
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </Row>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--fg-dim)',
                    marginTop: 6,
                    paddingLeft: 2,
                  }}
                >
                  Share with external parties — no login required.
                </div>
              </div>
            )}

            {error && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 5,
                  background:
                    'color-mix(in oklab, var(--danger) 10%, transparent)',
                  border: '1px solid var(--danger)',
                  fontSize: 11.5,
                  color: 'var(--danger)',
                }}
              >
                {error}
              </div>
            )}
          </Col>
        </div>

        {/* Footer */}
        <Row
          gap={8}
          justify="flex-end"
          style={{
            padding: '14px 22px',
            borderTop: '1px solid var(--border-faint)',
            background: 'var(--bg-sunken)',
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              marginRight: 'auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
            title={fileName}
          >
            {fileName}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleDownload}
            disabled={actionDisabled}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <IconDownload size={12} />
            {busy
              ? 'Working…'
              : format === 'html' && !reRender
                ? 'Open report'
                : format === 'html' && reRender
                  ? 'Render & download'
                  : 'Download'}
          </button>
        </Row>
      </div>
    </div>
  );
}

// ── Field wrapper (label + body) ──────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div
        className="eyebrow"
        style={{ fontSize: 9.5, marginBottom: 6, letterSpacing: 0.5 }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
