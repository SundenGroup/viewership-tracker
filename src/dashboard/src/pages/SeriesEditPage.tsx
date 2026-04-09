import { useState, useEffect, useMemo } from 'react';
import { Card, Button, FormField } from '@/components/common';
import { Modal } from '@/components/common/Modal';
import { Select } from '@/components/common/Select';
import { TextInput } from '@/components/common/TextInput';
import { TextArea } from '@/components/common/TextArea';
import { Spinner } from '@/components/common/Loader';
import { useAuth } from '@/hooks/useAuth';
import * as api from '@/services/api';
import type {
  SeriesWithStages,
  TournamentStatus,
  UserRole,
  CreateStage,
  CreateBroadcastDay,
} from '@/types/api';
import { useMutation } from '@/hooks/useMutation';
import { localTimeToUTC, utcToLocalTimeParts } from '@/utils/formatters';
import { TIMEZONE_OPTIONS } from '@/utils/timezones';

// ── Form state types ─────────────────────────────────────────────────────

interface DayForm {
  id?: string; // existing day ID (undefined = new)
  tempId: string;
  label: string;
  date: string;
  broadcast_start_time: string;
  broadcast_end_time: string;
  _deleted?: boolean;
}

interface StageForm {
  id?: string; // existing stage ID (undefined = new)
  tempId: string;
  name: string;
  order: number;
  start_date: string;
  end_date: string;
  broadcast_days: DayForm[];
  _deleted?: boolean;
}

interface ViewGroupForm {
  tempId: string;
  name: string;
  languages: string; // comma-separated
  platforms: string; // comma-separated
}

interface SeriesForm {
  name: string;
  short_name: string;
  game: string;
  partner: string;
  timezone: string;
  auto_start_polling: boolean;
  is_public: boolean;
  start_date: string;
  end_date: string;
  discovery_keywords: string;
  discovery_game_ids_twitch: string;
  discovery_game_ids_youtube: string;
  discovery_game_ids_kick: string;
  discovery_default_tier: string;
  status: TournamentStatus;
  min_role: UserRole;
  stages: StageForm[];
  viewGroups: ViewGroupForm[];
}

interface SeriesEditPageProps {
  seriesId: string;
  seriesDetail: SeriesWithStages;
  onSaved: () => void;
  onCancel: () => void;
  onDeleted: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────

let nextTempId = 1;
function tempId(): string {
  return `edit-temp-${nextTempId++}`;
}

function makeStage(order: number): StageForm {
  return {
    tempId: tempId(),
    name: '',
    order,
    start_date: '',
    end_date: '',
    broadcast_days: [],
  };
}

function makeDay(): DayForm {
  return {
    tempId: tempId(),
    label: '',
    date: '',
    broadcast_start_time: '',
    broadcast_end_time: '',
  };
}

function makeViewGroup(): ViewGroupForm {
  return {
    tempId: tempId(),
    name: '',
    languages: '',
    platforms: '',
  };
}

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
];

const VISIBILITY_OPTIONS = [
  { value: 'viewer', label: 'Everyone' },
  { value: 'editor', label: 'Editors & Admins' },
  { value: 'admin', label: 'Admins Only' },
];

function toDateStr(isoStr: string | null | undefined): string {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toISOString().split('T')[0] ?? '';
  } catch {
    return '';
  }
}

function seriesDetailToForm(detail: SeriesWithStages): SeriesForm {
  const gameIds = detail.discovery_game_ids ?? {};
  const seriesTimezone = detail.timezone ?? 'UTC';
  return {
    name: detail.name,
    short_name: detail.short_name ?? '',
    game: detail.game ?? '',
    partner: detail.partner ?? '',
    timezone: seriesTimezone,
    auto_start_polling: detail.auto_start_polling ?? true,
    is_public: detail.is_public ?? false,
    start_date: toDateStr(detail.start_date),
    end_date: toDateStr(detail.end_date),
    discovery_keywords: (detail.discovery_keywords ?? []).join(', '),
    discovery_game_ids_twitch: gameIds.twitch ?? '',
    discovery_game_ids_youtube: gameIds.youtube ?? '',
    discovery_game_ids_kick: gameIds.kick ?? '',
    discovery_default_tier: detail.discovery_default_tier ?? 'watch_party',
    status: detail.status,
    min_role: detail.min_role ?? 'viewer',
    stages: detail.stages.map((stage) => ({
      id: stage.id,
      tempId: tempId(),
      name: stage.name,
      order: stage.order,
      start_date: toDateStr(stage.start_date),
      end_date: toDateStr(stage.end_date),
      broadcast_days: stage.broadcast_days.map((day) => {
        const startParts = utcToLocalTimeParts(day.broadcast_start, seriesTimezone);
        const endParts = utcToLocalTimeParts(day.broadcast_end, seriesTimezone);
        return {
          id: day.id,
          tempId: tempId(),
          label: day.label,
          date: toDateStr(day.date),
          broadcast_start_time: startParts.time,
          broadcast_end_time: endParts.time,
        };
      }),
    })),
    viewGroups: ((detail.metadata?.viewGroups as Array<{ name: string; languages?: string[]; platforms?: string[] }>) ?? []).map((g) => ({
      tempId: tempId(),
      name: g.name ?? '',
      languages: (g.languages ?? []).join(', '),
      platforms: (g.platforms ?? []).join(', '),
    })),
  };
}

// ── Component ────────────────────────────────────────────────────────────

export function SeriesEditPage({
  seriesId,
  seriesDetail,
  onSaved,
  onCancel,
  onDeleted,
}: SeriesEditPageProps) {
  const { isAdmin } = useAuth();
  const [form, setForm] = useState<SeriesForm>(() => seriesDetailToForm(seriesDetail));
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupResult, setLookupResult] = useState<string | null>(null);
  const [twitchOptions, setTwitchOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [kickOptions, setKickOptions] = useState<Array<{ id: string; name: string }>>([]);

  // Reset form when seriesDetail changes (e.g. user switches series)
  useEffect(() => {
    setForm(seriesDetailToForm(seriesDetail));
    setError(null);
    setProgress('');
  }, [seriesDetail]);

  // ── Field updaters ───────────────────────────────────────────────────

  const updateField = <K extends keyof SeriesForm>(key: K, value: SeriesForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateStage = (stageIdx: number, key: keyof StageForm, value: string | number) => {
    setForm((prev) => {
      const stages = [...prev.stages];
      const stage = stages[stageIdx];
      if (!stage) return prev;
      stages[stageIdx] = { ...stage, [key]: value };
      return { ...prev, stages };
    });
  };

  const updateDay = (
    stageIdx: number,
    dayIdx: number,
    key: keyof DayForm,
    value: string,
  ) => {
    setForm((prev) => {
      const stages = [...prev.stages];
      const stage = stages[stageIdx];
      if (!stage) return prev;
      const days = [...stage.broadcast_days];
      const day = days[dayIdx];
      if (!day) return prev;
      days[dayIdx] = { ...day, [key]: value };
      stages[stageIdx] = { ...stage, broadcast_days: days };
      return { ...prev, stages };
    });
  };

  const addStage = () => {
    setForm((prev) => ({
      ...prev,
      stages: [...prev.stages, makeStage(prev.stages.length + 1)],
    }));
  };

  const removeStage = (stageIdx: number) => {
    setForm((prev) => {
      const stage = prev.stages[stageIdx];
      if (!stage) return prev;
      if (stage.id) {
        // Mark existing stage for deletion
        const stages = [...prev.stages];
        stages[stageIdx] = { ...stage, _deleted: true };
        return { ...prev, stages };
      }
      // New stage — just remove
      return {
        ...prev,
        stages: prev.stages
          .filter((_, i) => i !== stageIdx)
          .map((s, i) => ({ ...s, order: i + 1 })),
      };
    });
  };

  const addDay = (stageIdx: number) => {
    setForm((prev) => {
      const stages = [...prev.stages];
      const stage = stages[stageIdx];
      if (!stage) return prev;
      stages[stageIdx] = {
        ...stage,
        broadcast_days: [...stage.broadcast_days, makeDay()],
      };
      return { ...prev, stages };
    });
  };

  const removeDay = (stageIdx: number, dayIdx: number) => {
    setForm((prev) => {
      const stages = [...prev.stages];
      const stage = stages[stageIdx];
      if (!stage) return prev;
      const day = stage.broadcast_days[dayIdx];
      if (!day) return prev;
      if (day.id) {
        // Mark existing day for deletion
        const days = [...stage.broadcast_days];
        days[dayIdx] = { ...day, _deleted: true };
        stages[stageIdx] = { ...stage, broadcast_days: days };
      } else {
        stages[stageIdx] = {
          ...stage,
          broadcast_days: stage.broadcast_days.filter((_, i) => i !== dayIdx),
        };
      }
      return { ...prev, stages };
    });
  };

  // ── View Group updaters ──────────────────────────────────────────────

  const addViewGroup = () => {
    setForm((prev) => ({
      ...prev,
      viewGroups: [...prev.viewGroups, makeViewGroup()],
    }));
  };

  const removeViewGroup = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      viewGroups: prev.viewGroups.filter((_, i) => i !== idx),
    }));
  };

  const updateViewGroup = (idx: number, key: keyof ViewGroupForm, value: string) => {
    setForm((prev) => {
      const groups = [...prev.viewGroups];
      const group = groups[idx];
      if (!group) return prev;
      groups[idx] = { ...group, [key]: value };
      return { ...prev, viewGroups: groups };
    });
  };

  // ── Game ID Lookup ─────────────────────────────────────────────────

  const handleLookupGameIds = async () => {
    const gameName = form.game.trim();
    if (!gameName) return;

    setLookingUp(true);
    setLookupResult(null);
    setTwitchOptions([]);
    setKickOptions([]);

    try {
      const result = await api.lookupGameIds(gameName);

      // Store all options for picker
      setTwitchOptions(result.twitch);
      setKickOptions(result.kick);

      // Auto-select if only 1 result per platform
      if (result.twitch.length === 1) {
        updateField('discovery_game_ids_twitch', result.twitch[0].id);
      }
      if (result.kick.length === 1) {
        updateField('discovery_game_ids_kick', result.kick[0].id);
      }

      const msgs: string[] = [];
      msgs.push(`Twitch: ${result.twitch.length} match${result.twitch.length !== 1 ? 'es' : ''}`);
      msgs.push(`Kick: ${result.kick.length} match${result.kick.length !== 1 ? 'es' : ''}`);
      setLookupResult(msgs.join(' · ') + (result.twitch.length > 1 || result.kick.length > 1 ? ' — select below' : ''));
    } catch (err) {
      setLookupResult('Lookup failed — ' + (err instanceof Error ? err.message : 'unknown error'));
    } finally {
      setLookingUp(false);
    }
  };

  // ── Submit ───────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setError('Series name is required.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // 1. Update the series itself
      setProgress('Updating series...');
      const keywords = form.discovery_keywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);

      const gameIds: Record<string, string> = {};
      if (form.discovery_game_ids_twitch.trim()) gameIds.twitch = form.discovery_game_ids_twitch.trim();
      if (form.discovery_game_ids_youtube.trim()) gameIds.youtube = form.discovery_game_ids_youtube.trim();
      if (form.discovery_game_ids_kick.trim()) gameIds.kick = form.discovery_game_ids_kick.trim();

      // Build viewGroups for metadata (filter out empty groups)
      const viewGroups = form.viewGroups
        .filter((g) => g.name.trim())
        .map((g) => {
          const langs = g.languages.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
          const plats = g.platforms.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
          return {
            name: g.name.trim(),
            ...(langs.length > 0 ? { languages: langs } : {}),
            ...(plats.length > 0 ? { platforms: plats } : {}),
          };
        });

      // Merge with existing metadata (preserve autoReports, blocklist, etc.)
      const existingMetadata = (seriesDetail.metadata ?? {}) as Record<string, unknown>;
      const updatedMetadata = { ...existingMetadata, viewGroups };

      await api.updateSeries(seriesId, {
        name: form.name.trim(),
        short_name: form.short_name.trim() || undefined,
        game: form.game.trim() || undefined,
        partner: form.partner.trim() || undefined,
        status: form.status,
        timezone: form.timezone,
        auto_start_polling: form.auto_start_polling,
        is_public: form.is_public,
        min_role: isAdmin ? form.min_role : undefined,
        start_date: form.start_date || undefined,
        end_date: form.end_date || undefined,
        discovery_keywords: keywords.length > 0 ? keywords : [],
        discovery_game_ids: gameIds,
        discovery_default_tier: form.discovery_default_tier,
        metadata: updatedMetadata,
      });

      // 2. Process stages
      const visibleStages = form.stages.filter((s) => !s._deleted);
      const deletedStages = form.stages.filter((s) => s._deleted && s.id);

      // Delete removed stages
      for (const stage of deletedStages) {
        setProgress(`Deleting stage "${stage.name}"...`);
        await api.deleteStage(stage.id!);
      }

      // Create or update stages
      for (let si = 0; si < visibleStages.length; si++) {
        const stageForm = visibleStages[si]!;
        setProgress(`Saving stage ${si + 1} of ${visibleStages.length}...`);

        let stageId: string;

        if (stageForm.id) {
          // Update existing stage
          await api.updateStage(stageForm.id, {
            name: stageForm.name.trim() || `Stage ${si + 1}`,
            order: si + 1,
            start_date: stageForm.start_date || undefined,
            end_date: stageForm.end_date || undefined,
          });
          stageId = stageForm.id;
        } else {
          // Create new stage
          const stage = await api.createStage(seriesId, {
            name: stageForm.name.trim() || `Stage ${si + 1}`,
            order: si + 1,
            start_date: stageForm.start_date || undefined,
            end_date: stageForm.end_date || undefined,
          });
          stageId = stage.id;
        }

        // 3. Process broadcast days for this stage
        const visibleDays = stageForm.broadcast_days.filter((d) => !d._deleted);
        const deletedDays = stageForm.broadcast_days.filter((d) => d._deleted && d.id);

        // Delete removed days
        for (const day of deletedDays) {
          setProgress(`Deleting broadcast day "${day.label}"...`);
          await api.deleteBroadcastDay(day.id!);
        }

        // Create or update days
        for (let di = 0; di < visibleDays.length; di++) {
          const dayForm = visibleDays[di]!;
          setProgress(`Saving day ${di + 1} for ${stageForm.name || `Stage ${si + 1}`}...`);

          // Compute start/end UTC timestamps
          let computedStart = dayForm.broadcast_start_time && dayForm.date
            ? localTimeToUTC(dayForm.date, dayForm.broadcast_start_time, form.timezone)
            : undefined;
          let computedEnd = dayForm.broadcast_end_time && dayForm.date
            ? localTimeToUTC(dayForm.date, dayForm.broadcast_end_time, form.timezone)
            : undefined;

          // Cross-midnight fix: if end time is before or equal to start time,
          // the user intends the end to be on the next calendar day (e.g. start 19:00, end 05:30)
          if (computedStart && computedEnd) {
            const startMs = new Date(computedStart).getTime();
            const endMs = new Date(computedEnd).getTime();
            if (endMs <= startMs) {
              computedEnd = new Date(endMs + 24 * 60 * 60 * 1000).toISOString();
            }
          }

          const dayPayload = {
            label: dayForm.label.trim() || `Day ${di + 1}`,
            date: dayForm.date,
            broadcast_start: computedStart,
            broadcast_end: computedEnd,
          };

          if (dayForm.id) {
            // Update existing day
            await api.updateBroadcastDay(dayForm.id, dayPayload);
          } else {
            // Create new day
            await api.createBroadcastDay(stageId, dayPayload);
          }
        }
      }

      setProgress('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setProgress('');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSeries(seriesId);
      setDeleteModalOpen(false);
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete series');
    } finally {
      setDeleting(false);
    }
  };

  // ── Timeline ─────────────────────────────────────────────────────────

  const visibleStages = form.stages.filter((s) => !s._deleted);

  const timeline = useMemo(() => {
    if (!form.start_date || !form.end_date) return null;

    const seriesStart = new Date(form.start_date).getTime();
    const seriesEnd = new Date(form.end_date).getTime();
    const totalDuration = seriesEnd - seriesStart;
    if (totalDuration <= 0) return null;

    const toPercent = (dateStr: string) => {
      const t = new Date(dateStr).getTime();
      return Math.max(0, Math.min(100, ((t - seriesStart) / totalDuration) * 100));
    };

    const stageBlocks = visibleStages
      .filter((s) => s.start_date && s.end_date)
      .map((s) => ({
        label: s.name || `Stage ${s.order}`,
        left: toPercent(s.start_date),
        width: Math.max(2, toPercent(s.end_date) - toPercent(s.start_date)),
        days: s.broadcast_days
          .filter((d) => d.date && !d._deleted)
          .map((d) => ({
            label: d.label,
            position: toPercent(d.date),
          })),
      }));

    return { stageBlocks };
  }, [form.start_date, form.end_date, visibleStages]);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Card
        title={`Edit: ${seriesDetail.name}`}
        subtitle="Update tournament series configuration"
      >
        <div className="space-y-6">
          {/* Series Info */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Series Name" required>
              <TextInput
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="e.g. PUBG Esports Championship 2026"
              />
            </FormField>

            <FormField label="Short Name">
              <TextInput
                value={form.short_name}
                onChange={(e) => updateField('short_name', e.target.value)}
                placeholder="e.g. PEC 2026"
              />
            </FormField>

            <FormField label="Game">
              <TextInput
                value={form.game}
                onChange={(e) => updateField('game', e.target.value)}
                placeholder="e.g. PUBG: Battlegrounds"
              />
            </FormField>

            <FormField label="Partner">
              <TextInput
                value={form.partner}
                onChange={(e) => updateField('partner', e.target.value)}
                placeholder="e.g. Krafton"
              />
            </FormField>

            <FormField label="Start Date">
              <TextInput
                type="date"
                value={form.start_date}
                onChange={(e) => updateField('start_date', e.target.value)}
              />
            </FormField>

            <FormField label="End Date">
              <TextInput
                type="date"
                value={form.end_date}
                onChange={(e) => updateField('end_date', e.target.value)}
              />
            </FormField>

            <FormField label="Timezone">
              <Select
                options={TIMEZONE_OPTIONS}
                value={form.timezone}
                onChange={(e) => updateField('timezone', e.target.value)}
              />
            </FormField>

            <FormField label="Status">
              <Select
                options={STATUS_OPTIONS}
                value={form.status}
                onChange={(e) => updateField('status', e.target.value as TournamentStatus)}
              />
            </FormField>

            {isAdmin && (
              <FormField label="Visibility">
                <Select
                  options={VISIBILITY_OPTIONS}
                  value={form.min_role}
                  onChange={(e) => updateField('min_role', e.target.value as UserRole)}
                />
              </FormField>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                role="switch"
                aria-checked={form.auto_start_polling}
                onClick={() => updateField('auto_start_polling', !form.auto_start_polling)}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                  form.auto_start_polling ? 'bg-accent-green' : 'bg-navy-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                    form.auto_start_polling ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
              <div>
                <span className="text-sm font-medium text-gray-300">Auto-start live</span>
                <p className="text-xs text-gray-500">Automatically go live when broadcast start time arrives</p>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                role="switch"
                aria-checked={form.is_public}
                onClick={() => updateField('is_public', !form.is_public)}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                  form.is_public ? 'bg-accent-cyan' : 'bg-navy-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                    form.is_public ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
              <div>
                <span className="text-sm font-medium text-gray-300">Public dashboard</span>
                <p className="text-xs text-gray-500">Allow viewing the live dashboard without login</p>
                {form.is_public && form.short_name.trim() && (
                  <p className="mt-1 text-xs">
                    <span className="text-gray-500">Share link: </span>
                    <a
                      href={`${window.location.origin}/public/${form.short_name.trim()}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent-cyan hover:underline font-mono"
                    >
                      {window.location.origin}/public/{form.short_name.trim()}
                    </a>
                  </p>
                )}
                {form.is_public && !form.short_name.trim() && (
                  <p className="mt-1 text-xs text-accent-orange">
                    Set a short name above to generate the public URL
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Discovery Keywords">
              <TextArea
                value={form.discovery_keywords}
                onChange={(e) => updateField('discovery_keywords', e.target.value)}
                placeholder="Comma-separated: PEC, PUBG Championship, pubg esports"
                rows={2}
              />
            </FormField>

            <FormField label="Default Category for Discovered Channels">
              <Select
                value={form.discovery_default_tier}
                onChange={(e) => updateField('discovery_default_tier', e.target.value)}
                options={[
                  { value: 'watch_party', label: 'Watch Party' },
                  { value: 'community', label: 'Community' },
                  { value: 'partner', label: 'Partner' },
                  { value: 'official', label: 'Official' },
                  { value: 'player', label: 'Player' },
                ]}
              />
              <p className="mt-1 text-xs text-gray-500">
                Category assigned when approving channels from the discovery feed
              </p>
            </FormField>
          </div>

          {/* Discovery Game IDs */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Discovery Game IDs (Platform-specific)
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLookupGameIds}
                loading={lookingUp}
                disabled={!form.game.trim()}
                title={form.game.trim() ? `Look up IDs for "${form.game}"` : 'Enter a game name first'}
              >
                {lookupResult
                  ? 'Lookup IDs'
                  : 'Lookup IDs'}
              </Button>
            </div>
            {lookupResult && (
              <p className="mt-1 text-[10px] text-gray-500">{lookupResult}</p>
            )}
            {/* Category pickers — shown when lookup returns multiple results */}
            {twitchOptions.length > 1 && (
              <div className="mt-2">
                <label className="mb-1 block text-[10px] font-medium text-gray-400">Select Twitch Game</label>
                <select
                  className="w-full rounded border border-navy-700 bg-navy-800 px-2 py-1.5 text-xs text-white"
                  value={form.discovery_game_ids_twitch}
                  onChange={(e) => updateField('discovery_game_ids_twitch', e.target.value)}
                >
                  <option value="">— Choose —</option>
                  {twitchOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.name} (ID: {opt.id})</option>
                  ))}
                </select>
              </div>
            )}
            {kickOptions.length > 1 && (
              <div className="mt-2">
                <label className="mb-1 block text-[10px] font-medium text-gray-400">Select Kick Category</label>
                <select
                  className="w-full rounded border border-navy-700 bg-navy-800 px-2 py-1.5 text-xs text-white"
                  value={form.discovery_game_ids_kick}
                  onChange={(e) => updateField('discovery_game_ids_kick', e.target.value)}
                >
                  <option value="">— Choose —</option>
                  {kickOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.name} (ID: {opt.id})</option>
                  ))}
                </select>
              </div>
            )}
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField label="Twitch Game ID">
                <TextInput
                  value={form.discovery_game_ids_twitch}
                  onChange={(e) => updateField('discovery_game_ids_twitch', e.target.value)}
                  placeholder="e.g. 493057"
                />
              </FormField>
              <FormField label="YouTube Game Name">
                <TextInput
                  value={form.discovery_game_ids_youtube}
                  onChange={(e) => updateField('discovery_game_ids_youtube', e.target.value)}
                  placeholder="e.g. GeoGuessr"
                />
              </FormField>
              <FormField label="Kick Category ID">
                <TextInput
                  value={form.discovery_game_ids_kick}
                  onChange={(e) => updateField('discovery_game_ids_kick', e.target.value)}
                  placeholder="e.g. 15 (numeric)"
                />
              </FormField>
            </div>
          </div>
        </div>
      </Card>

      {/* Visual Timeline */}
      {timeline && timeline.stageBlocks.length > 0 && (
        <Card title="Timeline Preview">
          <div className="relative h-20">
            <div className="absolute inset-x-0 top-4 h-2 rounded-full bg-navy-700" />
            {timeline.stageBlocks.map((block, i) => (
              <div key={i}>
                <div
                  className="absolute top-3 h-4 rounded bg-clutch-red/20 border border-clutch-red/40"
                  style={{ left: `${block.left}%`, width: `${block.width}%` }}
                >
                  <span className="absolute -top-4 left-0 whitespace-nowrap text-[10px] text-gray-400">
                    {block.label}
                  </span>
                </div>
                {block.days.map((day, j) => (
                  <div
                    key={j}
                    className="absolute top-[14px] h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-accent-cyan border border-navy-900"
                    style={{ left: `${day.position}%` }}
                    title={day.label}
                  />
                ))}
              </div>
            ))}
            <div className="absolute inset-x-0 bottom-0 flex justify-between text-[10px] text-gray-600">
              <span>{form.start_date}</span>
              <span>{form.end_date}</span>
            </div>
          </div>
        </Card>
      )}

      {/* Stages */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-200">
            Stages ({visibleStages.length})
          </h3>
          <Button variant="primary" size="sm" onClick={addStage}>
            + Add Stage
          </Button>
        </div>

        {visibleStages.length === 0 && (
          <Card>
            <p className="py-4 text-center text-sm text-gray-500">
              No stages. Click &quot;+ Add Stage&quot; to add tournament stages.
            </p>
          </Card>
        )}

        {form.stages.map((stage, si) => {
          if (stage._deleted) return null;

          const visibleDays = stage.broadcast_days.filter((d) => !d._deleted);

          return (
            <Card key={stage.tempId}>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-gray-300">
                    {stage.id ? (
                      <span className="text-accent-cyan text-[10px] mr-2 uppercase">existing</span>
                    ) : (
                      <span className="text-accent-green text-[10px] mr-2 uppercase">new</span>
                    )}
                    Stage {stage.order}
                  </h4>
                  <button
                    onClick={() => removeStage(si)}
                    className="text-gray-600 transition-colors hover:text-accent-red"
                    title="Remove stage"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <FormField label="Name" required>
                    <TextInput
                      value={stage.name}
                      onChange={(e) => updateStage(si, 'name', e.target.value)}
                      placeholder="e.g. Group Stage"
                    />
                  </FormField>
                  <FormField label="Start Date">
                    <TextInput
                      type="date"
                      value={stage.start_date}
                      onChange={(e) => updateStage(si, 'start_date', e.target.value)}
                    />
                  </FormField>
                  <FormField label="End Date">
                    <TextInput
                      type="date"
                      value={stage.end_date}
                      onChange={(e) => updateStage(si, 'end_date', e.target.value)}
                    />
                  </FormField>
                </div>

                {/* Broadcast Days */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-500">
                      Broadcast Days ({visibleDays.length})
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => addDay(si)}>
                      + Day
                    </Button>
                  </div>

                  {visibleDays.length === 0 && (
                    <p className="py-2 text-center text-xs text-gray-600">
                      No broadcast days. Click &quot;+ Day&quot; to add one.
                    </p>
                  )}

                  <div className="space-y-2">
                    {stage.broadcast_days.map((day, di) => {
                      if (day._deleted) return null;
                      return (
                        <div
                          key={day.tempId}
                          className="flex items-start gap-2 rounded-lg bg-navy-800/40 p-2"
                        >
                          <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
                            <FormField label="Label" required>
                              <TextInput
                                value={day.label}
                                onChange={(e) => updateDay(si, di, 'label', e.target.value)}
                                placeholder="Day 1"
                              />
                            </FormField>
                            <FormField label="Date" required>
                              <TextInput
                                type="date"
                                value={day.date}
                                onChange={(e) => updateDay(si, di, 'date', e.target.value)}
                              />
                            </FormField>
                            <FormField label={`Start Time${form.timezone !== 'UTC' ? ` (${form.timezone.split('/').pop()})` : ''}`}>
                              <TextInput
                                type="time"
                                value={day.broadcast_start_time}
                                onChange={(e) =>
                                  updateDay(si, di, 'broadcast_start_time', e.target.value)
                                }
                              />
                            </FormField>
                            <FormField label={`End Time${form.timezone !== 'UTC' ? ` (${form.timezone.split('/').pop()})` : ''}`}>
                              <TextInput
                                type="time"
                                value={day.broadcast_end_time}
                                onChange={(e) =>
                                  updateDay(si, di, 'broadcast_end_time', e.target.value)
                                }
                              />
                            </FormField>
                          </div>
                          <button
                            onClick={() => removeDay(si, di)}
                            className="mt-5 flex-shrink-0 text-gray-600 transition-colors hover:text-accent-red"
                            title="Remove day"
                          >
                            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                              <path
                                fillRule="evenodd"
                                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* View Groups */}
      <Card
        title="View Groups"
        subtitle="Named filter presets for language and platform breakdowns (e.g. Western, Asian)"
      >
        <div className="space-y-3">
          {form.viewGroups.length === 0 && (
            <p className="py-2 text-center text-xs text-gray-600">
              No view groups configured. Add groups to filter dashboard data by language and platform.
            </p>
          )}

          {form.viewGroups.map((group, gi) => (
            <div
              key={group.tempId}
              className="flex items-start gap-2 rounded-lg bg-navy-800/40 p-3"
            >
              <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
                <FormField label="Group Name" required>
                  <TextInput
                    value={group.name}
                    onChange={(e) => updateViewGroup(gi, 'name', e.target.value)}
                    placeholder="e.g. Western"
                  />
                </FormField>
                <FormField label="Languages">
                  <TextInput
                    value={group.languages}
                    onChange={(e) => updateViewGroup(gi, 'languages', e.target.value)}
                    placeholder="en, es, pt, de, fr"
                  />
                  <p className="mt-0.5 text-[10px] text-gray-600">Comma-separated language codes</p>
                </FormField>
                <FormField label="Platforms">
                  <TextInput
                    value={group.platforms}
                    onChange={(e) => updateViewGroup(gi, 'platforms', e.target.value)}
                    placeholder="twitch, youtube, kick"
                  />
                  <p className="mt-0.5 text-[10px] text-gray-600">Comma-separated platform names</p>
                </FormField>
              </div>
              <button
                onClick={() => removeViewGroup(gi)}
                className="mt-5 flex-shrink-0 text-gray-600 transition-colors hover:text-accent-red"
                title="Remove group"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          ))}

          <Button variant="ghost" size="sm" onClick={addViewGroup}>
            + Add View Group
          </Button>
        </div>
      </Card>

      {/* Submit */}
      <div className="flex items-center justify-between rounded-xl border border-navy-700/50 bg-navy-850 px-6 py-4">
        <div>
          {error && <p className="text-sm text-accent-red">{error}</p>}
          {progress && (
            <p className="text-sm text-accent-cyan animate-pulse">{progress}</p>
          )}
        </div>

        <div className="flex gap-3">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!form.name.trim()}
          >
            Save Changes
          </Button>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="rounded-xl border border-red-900/40 bg-red-950/20 px-6 py-5">
        <h3 className="text-sm font-semibold text-red-400">Danger Zone</h3>
        <p className="mt-1 text-xs text-gray-500">
          Permanently delete this series and all associated data including stages, broadcast days,
          channels, and viewership snapshots. This action cannot be undone.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDeleteModalOpen(true);
            setDeleteConfirmText('');
            setDeleteError(null);
          }}
          className="mt-3 !border-red-900/60 !text-red-400 hover:!bg-red-950/40 hover:!text-red-300"
        >
          Delete Series
        </Button>
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Series"
        maxWidth="max-w-md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteModalOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <button
              onClick={handleDelete}
              disabled={deleteConfirmText !== seriesDetail.name || deleting}
              className={`
                rounded-lg px-4 py-2 text-sm font-medium transition-colors
                ${
                  deleteConfirmText === seriesDetail.name && !deleting
                    ? 'bg-red-600 text-white hover:bg-red-500'
                    : 'bg-red-900/30 text-red-400/40 cursor-not-allowed'
                }
              `}
            >
              {deleting ? 'Deleting...' : 'Delete Forever'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-red-900/40 bg-red-950/30 p-3">
            <p className="text-sm text-red-300">
              <span className="font-semibold">Warning:</span> This will permanently delete{' '}
              <span className="font-semibold text-red-200">{seriesDetail.name}</span> and all
              associated stages, broadcast days, channels, and viewership data.
            </p>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              Type <span className="font-mono text-gray-300">{seriesDetail.name}</span> to confirm
            </label>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={seriesDetail.name}
              className="w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500/50"
              autoFocus
            />
          </div>

          {deleteError && (
            <p className="text-sm text-red-400">{deleteError}</p>
          )}
        </div>
      </Modal>
    </div>
  );
}
