/**
 * SeriesForm — unified New / Edit series page.
 *
 * Ported from design_handoff_series_edit v7 (source/editor-dialogs.jsx).
 * Reuses the state model + mutation logic from the legacy SeriesEditPage +
 * SeriesSetupPage verbatim; the visual layer is fully rewritten.
 *
 * Mode:
 *   - 'new': blank form, "Create series" CTA, no danger zone
 *   - 'edit': pre-filled, "Save changes" CTA, Danger Zone (Archive, Delete)
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useViewportBelow } from '@/hooks/useViewport';
import * as api from '@/services/api';
import type {
  SeriesWithStages,
  TournamentStatus,
  UserRole,
  CreateStage,
  CreateBroadcastDay,
  CreateTournamentSeries,
} from '@/types/api';
import { localTimeToUTC, utcToLocalTimeParts } from '@/utils/formatters';
import { TIMEZONE_OPTIONS } from '@/utils/timezones';
import {
  Row,
  Col,
  ClutchWordmark,
  ThemeToggle,
  IconPlus,
  IconTrash,
  IconX,
} from '@/components/design';

// ── Form state types (matches v7 README + legacy pages) ──────────────────

interface DayForm {
  id?: string;
  tempId: string;
  label: string;
  date: string;
  broadcast_start_time: string;
  broadcast_end_time: string;
  _deleted?: boolean;
}

interface StageForm {
  id?: string;
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
  languages: string;
  platforms: string;
}

interface SeriesFormState {
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
  discovery_interval_ms: string;
  status: TournamentStatus;
  min_role: UserRole;
  stages: StageForm[];
  viewGroups: ViewGroupForm[];
}

let nextTempId = 1;
function tempId() {
  return `sf-${nextTempId++}`;
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
  return { tempId: tempId(), name: '', languages: '', platforms: '' };
}

function toDateStr(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toISOString().split('T')[0] ?? '';
  } catch {
    return '';
  }
}

function seriesDetailToForm(detail: SeriesWithStages): SeriesFormState {
  const gameIds = detail.discovery_game_ids ?? {};
  const tz = detail.timezone ?? 'UTC';
  return {
    name: detail.name,
    short_name: detail.short_name ?? '',
    game: detail.game ?? '',
    partner: detail.partner ?? '',
    timezone: tz,
    auto_start_polling: detail.auto_start_polling ?? true,
    is_public: detail.is_public ?? false,
    start_date: toDateStr(detail.start_date),
    end_date: toDateStr(detail.end_date),
    discovery_keywords: (detail.discovery_keywords ?? []).join(', '),
    discovery_game_ids_twitch: gameIds.twitch ?? '',
    discovery_game_ids_youtube: gameIds.youtube ?? '',
    discovery_game_ids_kick: gameIds.kick ?? '',
    discovery_default_tier: detail.discovery_default_tier ?? 'watch_party',
    discovery_interval_ms: (detail as { discovery_interval_ms?: number | null }).discovery_interval_ms
      ? String((detail as { discovery_interval_ms?: number | null }).discovery_interval_ms)
      : '',
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
        const s = utcToLocalTimeParts(day.broadcast_start, tz);
        const e = utcToLocalTimeParts(day.broadcast_end, tz);
        return {
          id: day.id,
          tempId: tempId(),
          label: day.label,
          date: toDateStr(day.date),
          broadcast_start_time: s.time,
          broadcast_end_time: e.time,
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

function emptyForm(): SeriesFormState {
  return {
    name: '',
    short_name: '',
    game: '',
    partner: '',
    timezone: 'UTC',
    auto_start_polling: true,
    is_public: false,
    start_date: '',
    end_date: '',
    discovery_keywords: '',
    discovery_game_ids_twitch: '',
    discovery_game_ids_youtube: '',
    discovery_game_ids_kick: '',
    discovery_default_tier: 'watch_party',
    discovery_interval_ms: '',
    status: 'draft',
    min_role: 'viewer',
    stages: [],
    viewGroups: [],
  };
}

const STATUS_OPTIONS: Array<{ value: TournamentStatus; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
];

const VISIBILITY_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: 'viewer', label: 'Everyone' },
  { value: 'editor', label: 'Editors & Admins' },
  { value: 'admin', label: 'Admins Only' },
];

const TIER_OPTIONS = [
  { value: 'watch_party', label: 'Watch Party' },
  { value: 'community', label: 'Community' },
  { value: 'partner', label: 'Partner' },
  { value: 'official', label: 'Official' },
  { value: 'player', label: 'Player POV' },
];

const INTERVAL_OPTIONS = [
  { value: '', label: 'Default (global config)' },
  { value: '120000', label: '2 minutes' },
  { value: '300000', label: '5 minutes' },
  { value: '600000', label: '10 minutes' },
  { value: '900000', label: '15 minutes' },
];

// ── Shared micro components ──────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 12.5,
  borderRadius: 5,
  border: '1px solid var(--border)',
  background: 'var(--bg-sunken)',
  color: 'var(--fg)',
  outline: 'none',
};

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <Col gap={5} style={{ minWidth: 0 }}>
      <div
        className="eyebrow"
        style={{
          fontSize: 9.5,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
        {required && <span style={{ color: 'var(--danger)', marginLeft: 3 }}>*</span>}
      </div>
      {children}
      {hint && (
        <span style={{ fontSize: 10.5, color: 'var(--fg-dim)', lineHeight: 1.4 }}>
          {hint}
        </span>
      )}
    </Col>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        width: 30,
        height: 17,
        borderRadius: 999,
        background: on ? 'var(--live)' : 'var(--bg-sunken)',
        border: `1px solid ${on ? 'var(--live)' : 'var(--border)'}`,
        position: 'relative',
        padding: 0,
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 140ms',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: on ? 14 : 1,
          width: 13,
          height: 13,
          borderRadius: '50%',
          background: on ? '#fff' : 'var(--fg-muted)',
          transition: 'left 140ms',
        }}
      />
    </button>
  );
}

function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      className="card"
      style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14, ...style }}
    >
      {children}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export interface SeriesFormPageProps {
  mode: 'new' | 'edit';
  /** Required when mode === 'edit'. */
  seriesDetail?: SeriesWithStages;
  seriesId?: string;
  onSaved: (seriesId?: string) => void;
  onCancel: () => void;
  onDeleted?: () => void;
}

export function SeriesFormPage({
  mode,
  seriesDetail,
  seriesId,
  onSaved,
  onCancel,
  onDeleted,
}: SeriesFormPageProps) {
  const isEdit = mode === 'edit';
  const { isAdmin } = useAuth();
  // Phone-sized viewport — collapse multi-column grids to single column,
  // drop chrome padding, reduce header sizes. 700 covers iPhone-class widths
  // and tight tablet portrait, while leaving normal phones in landscape on
  // the desktop layout.
  const isMobile = useViewportBelow(700);

  const [form, setForm] = useState<SeriesFormState>(() =>
    isEdit && seriesDetail ? seriesDetailToForm(seriesDetail) : emptyForm(),
  );

  // Re-seed if seriesDetail changes (rare)
  useEffect(() => {
    if (isEdit && seriesDetail) setForm(seriesDetailToForm(seriesDetail));
  }, [isEdit, seriesDetail]);

  // Deep-link from PublicLinkButton's "Enable in Series settings →"
  // (/:id/edit?focus=public): scroll to the public block and flash it.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).get('focus')) return;
    const el = document.getElementById('public-settings');
    if (!el) return;
    const t = setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'box-shadow 240ms ease';
      el.style.boxShadow = '0 0 0 3px var(--red-wash)';
      setTimeout(() => { el.style.boxShadow = 'none'; }, 1600);
    }, 250);
    return () => clearTimeout(t);
  }, []);

  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);

  // ── Update helpers ─────────────────────────────────────────────────

  const updateField = <K extends keyof SeriesFormState>(k: K, v: SeriesFormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  };

  const updateStage = (idx: number, key: keyof StageForm, v: string | number) => {
    setForm((f) => {
      const next = [...f.stages];
      const s = next[idx];
      if (!s) return f;
      next[idx] = { ...s, [key]: v };
      return { ...f, stages: next };
    });
  };

  const updateDay = (
    sIdx: number,
    dIdx: number,
    key: keyof DayForm,
    v: string,
  ) => {
    setForm((f) => {
      const stages = [...f.stages];
      const stage = stages[sIdx];
      if (!stage) return f;
      const days = [...stage.broadcast_days];
      const day = days[dIdx];
      if (!day) return f;
      days[dIdx] = { ...day, [key]: v };
      stages[sIdx] = { ...stage, broadcast_days: days };
      return { ...f, stages };
    });
  };

  const addStage = () => {
    setForm((f) => ({
      ...f,
      stages: [...f.stages, makeStage(f.stages.filter((s) => !s._deleted).length + 1)],
    }));
  };

  const removeStage = (idx: number) => {
    setForm((f) => {
      const stages = [...f.stages];
      const s = stages[idx];
      if (!s) return f;
      if (s.id) {
        stages[idx] = { ...s, _deleted: true };
      } else {
        stages.splice(idx, 1);
      }
      return { ...f, stages };
    });
  };

  const addDay = (sIdx: number) => {
    setForm((f) => {
      const stages = [...f.stages];
      const s = stages[sIdx];
      if (!s) return f;
      const newDay = makeDay();
      newDay.label = `Day ${s.broadcast_days.filter((d) => !d._deleted).length + 1}`;
      stages[sIdx] = { ...s, broadcast_days: [...s.broadcast_days, newDay] };
      return { ...f, stages };
    });
  };

  const removeDay = (sIdx: number, dIdx: number) => {
    setForm((f) => {
      const stages = [...f.stages];
      const s = stages[sIdx];
      if (!s) return f;
      const days = [...s.broadcast_days];
      const d = days[dIdx];
      if (!d) return f;
      if (d.id) {
        days[dIdx] = { ...d, _deleted: true };
      } else {
        days.splice(dIdx, 1);
      }
      stages[sIdx] = { ...s, broadcast_days: days };
      return { ...f, stages };
    });
  };

  const addGroup = () => setForm((f) => ({ ...f, viewGroups: [...f.viewGroups, makeViewGroup()] }));
  const removeGroup = (idx: number) =>
    setForm((f) => ({ ...f, viewGroups: f.viewGroups.filter((_, i) => i !== idx) }));
  const updateGroup = (idx: number, key: keyof ViewGroupForm, v: string) => {
    setForm((f) => {
      const next = [...f.viewGroups];
      const g = next[idx];
      if (!g) return f;
      next[idx] = { ...g, [key]: v };
      return { ...f, viewGroups: next };
    });
  };

  // ── Lookup game IDs ─────────────────────────────────────────────────

  const runLookup = async () => {
    const game = form.game.trim();
    if (!game) return;
    setLookingUp(true);
    setLookupMsg(`Looking up IDs for "${game}"…`);
    try {
      const result = await api.lookupGameIds(game);
      const parts: string[] = [];
      if (result.twitch.length === 1 && result.twitch[0]) {
        updateField('discovery_game_ids_twitch', result.twitch[0].id);
        parts.push(`Twitch ${result.twitch[0].id}`);
      } else if (result.twitch.length > 1) {
        parts.push(`Twitch: ${result.twitch.length} matches — pick below`);
      }
      if (result.kick.length === 1 && result.kick[0]) {
        updateField('discovery_game_ids_kick', result.kick[0].id);
        parts.push(`Kick ${result.kick[0].id}`);
      } else if (result.kick.length > 1) {
        parts.push(`Kick: ${result.kick.length} matches — pick below`);
      }
      setLookupMsg('Found: ' + (parts.length > 0 ? parts.join(' · ') : 'no matches'));
    } catch (e) {
      setLookupMsg('Lookup failed — ' + (e instanceof Error ? e.message : 'unknown error'));
    } finally {
      setLookingUp(false);
    }
  };

  // ── Submit (create or update) ──────────────────────────────────────

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setError('Series name is required.');
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const keywords = form.discovery_keywords
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const gameIds: Record<string, string> = {};
      if (form.discovery_game_ids_twitch.trim()) gameIds.twitch = form.discovery_game_ids_twitch.trim();
      if (form.discovery_game_ids_youtube.trim())
        gameIds.youtube = form.discovery_game_ids_youtube.trim();
      if (form.discovery_game_ids_kick.trim()) gameIds.kick = form.discovery_game_ids_kick.trim();

      const viewGroups = form.viewGroups
        .filter((g) => g.name.trim())
        .map((g) => ({
          name: g.name.trim(),
          ...(g.languages.trim()
            ? {
                languages: g.languages
                  .split(',')
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean),
              }
            : {}),
          ...(g.platforms.trim()
            ? {
                platforms: g.platforms
                  .split(',')
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean),
              }
            : {}),
        }));

      const basePayload: Partial<CreateTournamentSeries> & { metadata?: Record<string, unknown> } = {
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
        discovery_keywords: keywords,
        discovery_game_ids: gameIds,
        discovery_default_tier: form.discovery_default_tier,
        discovery_interval_ms: form.discovery_interval_ms
          ? parseInt(form.discovery_interval_ms, 10)
          : null,
      };

      // Merge existing metadata on edit so we don't clobber autoReports/blocklist/etc.
      const existingMeta = (seriesDetail?.metadata ?? {}) as Record<string, unknown>;
      const metadata = { ...existingMeta, viewGroups };

      let targetId = seriesId;
      if (isEdit && targetId) {
        setProgress('Updating series…');
        await api.updateSeries(targetId, { ...basePayload, metadata });
      } else {
        setProgress('Creating series…');
        const created = await api.createSeries({
          ...(basePayload as CreateTournamentSeries),
          metadata,
        });
        targetId = created.id;
      }

      // Stages + days diff
      const visibleStages = form.stages.filter((s) => !s._deleted);
      const deletedStages = form.stages.filter((s) => s._deleted && s.id);

      for (const s of deletedStages) {
        setProgress(`Deleting stage "${s.name}"…`);
        await api.deleteStage(s.id!);
      }

      for (let si = 0; si < visibleStages.length; si++) {
        const sf = visibleStages[si]!;
        setProgress(`Saving stage ${si + 1} of ${visibleStages.length}…`);
        const stagePayload: CreateStage = {
          name: sf.name.trim() || `Stage ${si + 1}`,
          order: si + 1,
          start_date: sf.start_date || undefined,
          end_date: sf.end_date || undefined,
        };
        let stageId: string;
        if (sf.id) {
          await api.updateStage(sf.id, stagePayload);
          stageId = sf.id;
        } else {
          const stage = await api.createStage(targetId!, stagePayload);
          stageId = stage.id;
        }

        const visibleDays = sf.broadcast_days.filter((d) => !d._deleted);
        const deletedDays = sf.broadcast_days.filter((d) => d._deleted && d.id);
        for (const d of deletedDays) {
          setProgress(`Deleting day "${d.label}"…`);
          await api.deleteBroadcastDay(d.id!);
        }
        for (let di = 0; di < visibleDays.length; di++) {
          const df = visibleDays[di]!;
          setProgress(`Saving day ${di + 1} of ${visibleDays.length} (${sf.name})…`);
          let startUTC =
            df.broadcast_start_time && df.date
              ? localTimeToUTC(df.date, df.broadcast_start_time, form.timezone)
              : undefined;
          let endUTC =
            df.broadcast_end_time && df.date
              ? localTimeToUTC(df.date, df.broadcast_end_time, form.timezone)
              : undefined;
          // Cross-midnight fix
          if (startUTC && endUTC) {
            const sMs = new Date(startUTC).getTime();
            const eMs = new Date(endUTC).getTime();
            if (eMs <= sMs) endUTC = new Date(eMs + 24 * 60 * 60 * 1000).toISOString();
          }
          const payload: CreateBroadcastDay = {
            label: df.label.trim() || `Day ${di + 1}`,
            date: df.date,
            broadcast_start: startUTC,
            broadcast_end: endUTC,
          };
          if (df.id) {
            await api.updateBroadcastDay(df.id, payload);
          } else {
            await api.createBroadcastDay(stageId, payload);
          }
        }
      }

      setProgress('');
      onSaved(targetId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setProgress('');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!seriesId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSeries(seriesId);
      setDeleteOpen(false);
      onDeleted?.();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  // ── Timeline preview ────────────────────────────────────────────────

  const timeline = useMemo(() => {
    if (!form.start_date || !form.end_date) return null;
    const s0 = new Date(form.start_date).getTime();
    const e0 = new Date(form.end_date).getTime();
    const span = Math.max(1, e0 - s0);
    return form.stages
      .filter((s) => !s._deleted)
      .map((st) => {
        const s = new Date(st.start_date).getTime();
        const e = new Date(st.end_date).getTime();
        if (isNaN(s) || isNaN(e)) return null;
        return {
          key: st.tempId,
          name: st.name || 'Stage',
          left: Math.max(0, ((s - s0) / span) * 100),
          width: Math.max(2, ((e - s) / span) * 100),
          days: st.broadcast_days
            .filter((d) => !d._deleted)
            .map((d) => {
              const dt = new Date(d.date).getTime();
              if (isNaN(dt)) return null;
              return { pos: ((dt - s0) / span) * 100, label: d.label };
            })
            .filter((x): x is { pos: number; label: string } => x !== null),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [form.start_date, form.end_date, form.stages]);

  const visibleStages = form.stages.filter((s) => !s._deleted);
  const tzLabel = useMemo(() => {
    const opt = TIMEZONE_OPTIONS.find((o) => o.value === form.timezone);
    if (!opt) return form.timezone;
    const m = opt.label.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b$/);
    return m ? m[1] : form.timezone.split('/').pop() ?? form.timezone;
  }, [form.timezone]);

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        paddingBottom: 120, // room for sticky save bar
      }}
    >
      {/* Thin top bar with wordmark + theme toggle */}
      <div
        style={{
          padding: isMobile ? '12px 16px' : '14px 32px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-raised)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Row gap={8}>
          <ClutchWordmark size={14} />
        </Row>
        <ThemeToggle />
      </div>

      <div
        style={{
          padding: isMobile ? '20px 16px 96px' : '32px 48px 64px',
          maxWidth: 1000,
          margin: '0 auto',
        }}
      >
        {/* Page header — stacks vertically on mobile so the action buttons
            don't overflow next to the title. */}
        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            justifyContent: 'space-between',
            alignItems: isMobile ? 'stretch' : 'flex-start',
            gap: isMobile ? 14 : 12,
            marginBottom: 24,
          }}
        >
          <Col gap={4} style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow">{isEdit ? 'Edit series' : 'New series'}</div>
            <h1
              style={{
                margin: 0,
                fontSize: isMobile ? 22 : 28,
                letterSpacing: '-0.02em',
                fontWeight: 500,
              }}
            >
              {isEdit ? `Edit: ${seriesDetail?.name ?? '—'}` : 'New series'}
            </h1>
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4 }}>
              {isEdit
                ? 'Update tournament series configuration'
                : 'Define a tournament series from scratch'}
            </div>
          </Col>
          <Row gap={8} style={{ flexShrink: 0 }}>
            <button
              type="button"
              className="btn"
              onClick={onCancel}
              disabled={submitting}
              style={{ whiteSpace: 'nowrap', flex: isMobile ? 1 : undefined }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={submitting}
              style={{ whiteSpace: 'nowrap', flex: isMobile ? 1 : undefined }}
            >
              {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create series'}
            </button>
          </Row>
        </div>

        {/* Inline progress + error */}
        {(progress || error) && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 14px',
              borderRadius: 5,
              background: error ? 'color-mix(in oklab, var(--danger) 10%, transparent)' : 'var(--bg-card)',
              border: `1px solid ${error ? 'color-mix(in oklab, var(--danger) 30%, transparent)' : 'var(--border)'}`,
              fontSize: 12.5,
              color: error ? 'var(--danger)' : 'var(--fg-muted)',
            }}
          >
            {error ?? progress}
          </div>
        )}

        <Col gap={16}>
          {/* ── Basics ───────────────────────────────────────────── */}
          <Card>
            <div className="eyebrow">Basics</div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14 }}>
              <Field label="Series Name" required>
                <input
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="e.g. PUBG Esports Championship 2026"
                  style={inputStyle}
                />
              </Field>
              <Field label="Short Name" hint="used in share URLs">
                <input
                  value={form.short_name}
                  onChange={(e) => updateField('short_name', e.target.value)}
                  placeholder="e.g. PEC-2026"
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                />
              </Field>
              <Field label="Game">
                <input
                  value={form.game}
                  onChange={(e) => updateField('game', e.target.value)}
                  placeholder="e.g. PUBG: Battlegrounds"
                  style={inputStyle}
                />
              </Field>
              <Field label="Partner">
                <input
                  value={form.partner}
                  onChange={(e) => updateField('partner', e.target.value)}
                  placeholder="e.g. KRAFTON"
                  style={inputStyle}
                />
              </Field>
              <Field label="Start Date">
                <input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => updateField('start_date', e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="End Date">
                <input
                  type="date"
                  value={form.end_date}
                  onChange={(e) => updateField('end_date', e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Timezone">
                <select
                  value={form.timezone}
                  onChange={(e) => updateField('timezone', e.target.value)}
                  style={inputStyle}
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <select
                  value={form.status}
                  onChange={(e) => updateField('status', e.target.value as TournamentStatus)}
                  style={inputStyle}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              {isAdmin && (
                <Field label="Visibility" hint="admin only">
                  <select
                    value={form.min_role}
                    onChange={(e) => updateField('min_role', e.target.value as UserRole)}
                    style={inputStyle}
                  >
                    {VISIBILITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingTop: 22 }}>
                <Toggle
                  on={form.auto_start_polling}
                  onChange={(v) => updateField('auto_start_polling', v)}
                />
                <Col gap={2}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>Auto-start live</span>
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                    Automatically go live when broadcast start time arrives
                  </span>
                </Col>
              </div>
            </div>

            {/* Public dashboard sub-block */}
            <div
              id="public-settings"
              style={{
                marginTop: 4,
                padding: 14,
                borderRadius: 5,
                border: `1px solid ${form.is_public ? 'color-mix(in oklab, var(--red) 30%, transparent)' : 'var(--border)'}`,
                background: form.is_public
                  ? 'color-mix(in oklab, var(--red) 5%, transparent)'
                  : 'var(--bg-sunken)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <Row gap={12} align="flex-start">
                <Toggle on={form.is_public} onChange={(v) => updateField('is_public', v)} />
                <Col gap={2} style={{ flex: 1 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>Public dashboard</span>
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                    Allow viewing the live dashboard without login
                  </span>
                </Col>
              </Row>
              {form.is_public &&
                (form.short_name.trim() ? (
                  <div
                    style={{
                      fontSize: 11.5,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--red)',
                    }}
                  >
                    Share link: https://tracker.clutch.game/public/{form.short_name.trim()}
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, color: 'var(--warn)' }}>
                    Set a short name above to generate the public URL.
                  </div>
                ))}
            </div>
          </Card>

          {/* ── Discovery ────────────────────────────────────────── */}
          <Card>
            <div className="eyebrow">Discovery</div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14 }}>
              <Field
                label="Discovery Keywords"
                hint="comma-separated. Used to match new streams on Twitch/YouTube/Kick search"
              >
                <textarea
                  rows={2}
                  value={form.discovery_keywords}
                  onChange={(e) => updateField('discovery_keywords', e.target.value)}
                  placeholder="PEC, PUBG EMEA CHAMPIONSHIP"
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-mono)' }}
                />
              </Field>
              <Field label="Default Category for Discovered Channels">
                <select
                  value={form.discovery_default_tier}
                  onChange={(e) => updateField('discovery_default_tier', e.target.value)}
                  style={inputStyle}
                >
                  {TIER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Discovery Interval">
                <select
                  value={form.discovery_interval_ms}
                  onChange={(e) => updateField('discovery_interval_ms', e.target.value)}
                  style={inputStyle}
                >
                  {INTERVAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {/* Discovery Game IDs section */}
            <Row justify="space-between" style={{ marginTop: 4 }}>
              <span className="eyebrow">Discovery Game IDs (Platform-specific)</span>
              <button
                type="button"
                className="btn btn-xs"
                onClick={runLookup}
                disabled={!form.game.trim() || lookingUp}
                style={{ opacity: form.game.trim() && !lookingUp ? 1 : 0.5 }}
              >
                {lookingUp ? 'Looking up…' : 'Lookup IDs'}
              </button>
            </Row>
            {lookupMsg && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--fg-muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {lookupMsg}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 14 }}>
              <Field label="Twitch Game ID">
                <input
                  value={form.discovery_game_ids_twitch}
                  onChange={(e) => updateField('discovery_game_ids_twitch', e.target.value)}
                  placeholder="e.g. 493057"
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                />
              </Field>
              <Field label="YouTube Game Name">
                <input
                  value={form.discovery_game_ids_youtube}
                  onChange={(e) => updateField('discovery_game_ids_youtube', e.target.value)}
                  placeholder="e.g. GeoGuessr"
                  style={inputStyle}
                />
              </Field>
              <Field label="Kick Category ID">
                <input
                  value={form.discovery_game_ids_kick}
                  onChange={(e) => updateField('discovery_game_ids_kick', e.target.value)}
                  placeholder="e.g. 15 (numeric)"
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                />
              </Field>
            </div>
          </Card>

          {/* ── Timeline preview ────────────────────────────────── */}
          {isEdit &&
            timeline &&
            timeline.length > 0 &&
            form.start_date &&
            form.end_date && (
              <Card>
                <div className="eyebrow">Timeline preview</div>
                <div style={{ position: 'relative', height: 70, marginTop: 8 }}>
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: 32,
                      height: 6,
                      background: 'var(--bg-sunken)',
                      border: '1px solid var(--border-faint)',
                      borderRadius: 3,
                    }}
                  />
                  {timeline.map((st) => (
                    <div key={st.key}>
                      <div
                        style={{
                          position: 'absolute',
                          top: 14,
                          left: st.left + '%',
                          fontSize: 10.5,
                          color: 'var(--fg-muted)',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {st.name}
                      </div>
                      <div
                        style={{
                          position: 'absolute',
                          top: 28,
                          left: st.left + '%',
                          width: st.width + '%',
                          height: 14,
                          background: 'color-mix(in oklab, var(--red) 20%, transparent)',
                          border: '1px solid color-mix(in oklab, var(--red) 50%, transparent)',
                          borderRadius: 3,
                        }}
                      />
                      {st.days.map((d, di) => (
                        <div
                          key={di}
                          title={d.label}
                          style={{
                            position: 'absolute',
                            top: 31,
                            left: `calc(${d.pos}% - 4px)`,
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: 'var(--red)',
                          }}
                        />
                      ))}
                    </div>
                  ))}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      fontSize: 10,
                      color: 'var(--fg-dim)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {form.start_date}
                  </div>
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      right: 0,
                      fontSize: 10,
                      color: 'var(--fg-dim)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {form.end_date}
                  </div>
                </div>
              </Card>
            )}

          {/* ── Stages header + cards ──────────────────────────── */}
          <Row justify="space-between" align="center" style={{ marginTop: 4 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500, whiteSpace: 'nowrap' }}>
              Stages ({visibleStages.length})
            </h2>
            <button
              type="button"
              className="btn btn-xs btn-primary"
              onClick={addStage}
              style={{ whiteSpace: 'nowrap' }}
            >
              <IconPlus size={11} /> Add Stage
            </button>
          </Row>

          {visibleStages.length === 0 ? (
            <Card style={{ textAlign: 'center', padding: 28 }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
                No stages. Click "+ Add Stage" to add tournament stages.
              </span>
            </Card>
          ) : (
            <Col gap={16}>
              {form.stages.map((stage, sIdx) => {
                if (stage._deleted) return null;
                const isNew = !stage.id;
                return (
                  <Card key={stage.tempId} style={{ padding: 20 }}>
                    <Row justify="space-between" align="center">
                      <Row gap={10}>
                        <span
                          className="eyebrow"
                          style={{
                            color: isNew ? 'var(--live)' : 'var(--red)',
                            fontSize: 9,
                          }}
                        >
                          {isNew ? 'NEW' : 'EXISTING'}
                        </span>
                        <span
                          style={{
                            fontSize: 13.5,
                            fontWeight: 500,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Stage {sIdx + 1}
                        </span>
                      </Row>
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={() => removeStage(sIdx)}
                        title="Remove stage"
                        style={{ color: 'var(--fg-muted)', padding: 4 }}
                      >
                        <IconTrash size={12} />
                      </button>
                    </Row>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr 1fr',
                        gap: 14,
                      }}
                    >
                      <Field label="Name" required>
                        <input
                          value={stage.name}
                          onChange={(e) => updateStage(sIdx, 'name', e.target.value)}
                          placeholder="e.g. Group Stage"
                          style={inputStyle}
                        />
                      </Field>
                      <Field label="Start Date">
                        <input
                          type="date"
                          value={stage.start_date}
                          onChange={(e) => updateStage(sIdx, 'start_date', e.target.value)}
                          style={inputStyle}
                        />
                      </Field>
                      <Field label="End Date">
                        <input
                          type="date"
                          value={stage.end_date}
                          onChange={(e) => updateStage(sIdx, 'end_date', e.target.value)}
                          style={inputStyle}
                        />
                      </Field>
                    </div>

                    {/* Broadcast days */}
                    <Row justify="space-between" style={{ marginTop: 4 }}>
                      <span className="eyebrow">
                        Broadcast days ({stage.broadcast_days.filter((d) => !d._deleted).length})
                      </span>
                      <button
                        type="button"
                        onClick={() => addDay(sIdx)}
                        className="btn btn-xs btn-ghost"
                        style={{ color: 'var(--red)', whiteSpace: 'nowrap' }}
                      >
                        <IconPlus size={11} /> Day
                      </button>
                    </Row>

                    {stage.broadcast_days.filter((d) => !d._deleted).length === 0 ? (
                      <div style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>
                        No broadcast days. Click "+ Day" to add one.
                      </div>
                    ) : (
                      <Col gap={6}>
                        {stage.broadcast_days.map((day, dIdx) => {
                          if (day._deleted) return null;
                          return (
                            <div
                              key={day.tempId}
                              style={{
                                padding: 10,
                                background: 'var(--bg-sunken)',
                                border: '1px solid var(--border-faint)',
                                borderRadius: 5,
                                display: 'grid',
                                // Phone: Label/Date/Start/End stacked; Remove at the end.
                                // Desktop: single horizontal row.
                                gridTemplateColumns: isMobile
                                  ? '1fr 1fr'
                                  : '1.4fr 1fr 1fr 1fr 24px',
                                gap: 10,
                                alignItems: 'flex-end',
                              }}
                            >
                              <Field label="Label" required>
                                <input
                                  value={day.label}
                                  onChange={(e) =>
                                    updateDay(sIdx, dIdx, 'label', e.target.value)
                                  }
                                  placeholder="Day 1"
                                  style={inputStyle}
                                />
                              </Field>
                              <Field label="Date" required>
                                <input
                                  type="date"
                                  value={day.date}
                                  onChange={(e) =>
                                    updateDay(sIdx, dIdx, 'date', e.target.value)
                                  }
                                  style={inputStyle}
                                />
                              </Field>
                              <Field label={`Start (${tzLabel})`}>
                                <input
                                  type="time"
                                  value={day.broadcast_start_time}
                                  onChange={(e) =>
                                    updateDay(sIdx, dIdx, 'broadcast_start_time', e.target.value)
                                  }
                                  style={inputStyle}
                                />
                              </Field>
                              <Field label={`End (${tzLabel})`}>
                                <input
                                  type="time"
                                  value={day.broadcast_end_time}
                                  onChange={(e) =>
                                    updateDay(sIdx, dIdx, 'broadcast_end_time', e.target.value)
                                  }
                                  style={inputStyle}
                                />
                              </Field>
                              <button
                                type="button"
                                className="btn btn-xs btn-ghost"
                                onClick={() => removeDay(sIdx, dIdx)}
                                title="Remove day"
                                style={{
                                  color: 'var(--fg-muted)',
                                  padding: 4,
                                  alignSelf: 'flex-end',
                                  marginBottom: 4,
                                }}
                              >
                                <IconX size={12} />
                              </button>
                            </div>
                          );
                        })}
                      </Col>
                    )}
                  </Card>
                );
              })}
            </Col>
          )}

          {/* ── View Groups ──────────────────────────────────────── */}
          <Card>
            <Row gap={10}>
              <div className="eyebrow">View Groups</div>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                Named filter presets for language and platform breakdowns (e.g. Western, Asian)
              </span>
            </Row>
            {form.viewGroups.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--fg-dim)' }}>
                No view groups configured. Add groups to filter dashboard data by language and
                platform.
              </div>
            ) : (
              <Col gap={8}>
                {form.viewGroups.map((g, idx) => (
                  <div
                    key={g.tempId}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: isMobile
                        ? '1fr'
                        : '1fr 1.2fr 1.2fr 36px',
                      gap: 10,
                      alignItems: 'flex-end',
                    }}
                  >
                    <Field label="Group Name" required>
                      <input
                        value={g.name}
                        onChange={(e) => updateGroup(idx, 'name', e.target.value)}
                        placeholder="e.g. Western"
                        style={inputStyle}
                      />
                    </Field>
                    <Field label="Languages" hint="ISO codes, comma-separated">
                      <input
                        value={g.languages}
                        onChange={(e) => updateGroup(idx, 'languages', e.target.value)}
                        placeholder="en, es, pt, fr, de"
                        style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                      />
                    </Field>
                    <Field label="Platforms" hint="platform keys, comma-separated">
                      <input
                        value={g.platforms}
                        onChange={(e) => updateGroup(idx, 'platforms', e.target.value)}
                        placeholder="twitch, youtube, kick"
                        style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                      />
                    </Field>
                    <button
                      type="button"
                      onClick={() => removeGroup(idx)}
                      className="btn btn-xs btn-ghost"
                      title="Remove group"
                      style={{ color: 'var(--fg-muted)', padding: 4, alignSelf: 'flex-end' }}
                    >
                      <IconX size={12} />
                    </button>
                  </div>
                ))}
              </Col>
            )}
            <button
              type="button"
              onClick={addGroup}
              className="btn btn-xs btn-ghost"
              style={{ alignSelf: 'flex-start', color: 'var(--red)' }}
            >
              <IconPlus size={11} /> Add View Group
            </button>
          </Card>

          {/* ── Danger zone (edit only) ────────────────────────── */}
          {isEdit && seriesId && (
            <div
              className="card"
              style={{
                padding: 0,
                border: '1px solid color-mix(in oklab, var(--danger) 30%, transparent)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--border-faint)' }}>
                <div
                  className="eyebrow"
                  style={{ color: 'var(--danger)', fontSize: 10 }}
                >
                  Danger zone
                </div>
              </div>

              <DangerRow
                title="Archive series"
                desc="Stop polling, hide from main nav. Data is preserved and reports stay accessible."
                button={
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => updateField('status', 'completed')}
                    style={{
                      color: 'var(--warn)',
                      borderColor: 'color-mix(in oklab, var(--warn) 30%, transparent)',
                      background: 'color-mix(in oklab, var(--warn) 10%, transparent)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Archive
                  </button>
                }
              />

              <DangerRow
                title="Delete series"
                desc="Permanently remove this series, its channels, and all tracked data. This cannot be undone."
                button={
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => setDeleteOpen(true)}
                    style={{
                      color: 'var(--danger)',
                      borderColor: 'color-mix(in oklab, var(--danger) 30%, transparent)',
                      background: 'color-mix(in oklab, var(--danger) 10%, transparent)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Delete…
                  </button>
                }
                last
              />
            </div>
          )}
        </Col>
      </div>

      {/* Sticky save bar */}
      <div
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          padding: '12px 48px',
          background: 'var(--bg-sunken)',
          borderTop: '1px solid var(--border-faint)',
          display: 'flex',
          justifyContent: 'center',
          zIndex: 10,
        }}
      >
        <div
          style={{
            maxWidth: 1000,
            width: '100%',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          {(error || progress) && (
            <span
              role={error ? 'alert' : undefined}
              style={{
                alignSelf: 'center',
                fontSize: 11.5,
                color: error ? 'var(--danger)' : 'var(--fg-muted)',
                marginRight: 'auto',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {/* The banner at the top of the page is invisible from down
                  here, and here is where the Save button lives. */}
              {error ?? progress}
            </span>
          )}
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={submitting}
            style={{ whiteSpace: 'nowrap' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={submitting}
            style={{ whiteSpace: 'nowrap' }}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create series'}
          </button>
        </div>
      </div>

      {/* Delete confirm modal */}
      {deleteOpen && isEdit && seriesDetail && (
        <DeleteModal
          series={seriesDetail}
          confirm={deleteConfirm}
          onConfirmChange={setDeleteConfirm}
          onClose={() => {
            setDeleteOpen(false);
            setDeleteConfirm('');
            setDeleteError(null);
          }}
          onDelete={handleDelete}
          deleting={deleting}
          error={deleteError}
        />
      )}
    </div>
  );
}

// ── Danger row ──────────────────────────────────────────────────────────

function DangerRow({
  title,
  desc,
  button,
  last,
}: {
  title: string;
  desc: string;
  button: ReactNode;
  last?: boolean;
}) {
  return (
    <Row
      justify="space-between"
      align="center"
      style={{
        padding: '14px 22px',
        gap: 16,
        borderBottom: last ? 'none' : '1px solid var(--border-faint)',
      }}
    >
      <Col gap={3} style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
        <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.4 }}>{desc}</span>
      </Col>
      {button}
    </Row>
  );
}

// ── Delete modal ────────────────────────────────────────────────────────

function DeleteModal({
  series,
  confirm,
  onConfirmChange,
  onClose,
  onDelete,
  deleting,
  error,
}: {
  series: SeriesWithStages;
  confirm: string;
  onConfirmChange: (v: string) => void;
  onClose: () => void;
  onDelete: () => void;
  deleting: boolean;
  error: string | null;
}) {
  const stageCount = series.stages.length;
  const shortName = series.short_name ?? '';
  const confirmMatches = confirm.trim() === shortName.trim() && shortName.length > 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20,
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: '92vw',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '18px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div className="eyebrow" style={{ color: 'var(--danger)', fontSize: 10 }}>
            Delete series
          </div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>This cannot be undone</h2>
          <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.5, margin: 0 }}>
            Deleting <b>{series.name}</b> will permanently remove all {stageCount}{' '}
            {stageCount === 1 ? 'stage' : 'stages'}, broadcast days, tracked channels, and
            viewership data.
          </p>
          {shortName ? (
            <Field
              label={`Type the short name "${shortName}" to confirm`}
              required
            >
              <input
                autoFocus
                value={confirm}
                onChange={(e) => onConfirmChange(e.target.value)}
                placeholder={shortName}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              />
            </Field>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--warn)' }}>
              No short name set on this series. Any text will proceed.
            </div>
          )}
          {error && (
            <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{error}</div>
          )}
        </div>
        <Row
          justify="flex-end"
          gap={8}
          style={{
            padding: '12px 22px',
            borderTop: '1px solid var(--border-faint)',
            background: 'var(--bg-sunken)',
          }}
        >
          <button type="button" className="btn" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting || (!!shortName && !confirmMatches)}
            className="btn"
            style={{
              background: confirmMatches || !shortName ? 'var(--danger)' : 'var(--bg-hover)',
              color: confirmMatches || !shortName ? 'white' : 'var(--fg-dim)',
              border:
                confirmMatches || !shortName
                  ? '1px solid var(--danger)'
                  : '1px solid var(--border)',
            }}
          >
            {deleting ? 'Deleting…' : 'Delete permanently'}
          </button>
        </Row>
      </div>
    </div>
  );
}

