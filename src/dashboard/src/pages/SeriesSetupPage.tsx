import { useState, useMemo } from 'react';
import { Card, Button, FormField } from '@/components/common';
import { Select } from '@/components/common/Select';
import { TextInput } from '@/components/common/TextInput';
import { TextArea } from '@/components/common/TextArea';
import * as api from '@/services/api';

// ── Form state types ─────────────────────────────────────────────────────

interface DayForm {
  tempId: string;
  label: string;
  date: string;
  broadcast_start: string;
  broadcast_end: string;
}

interface StageForm {
  tempId: string;
  name: string;
  order: number;
  start_date: string;
  end_date: string;
  broadcast_days: DayForm[];
}

interface SeriesForm {
  name: string;
  short_name: string;
  game: string;
  partner: string;
  start_date: string;
  end_date: string;
  discovery_keywords: string;
  status: 'draft' | 'active' | 'completed';
  stages: StageForm[];
}

interface SeriesSetupPageProps {
  onCreated: (seriesId: string) => void;
  onCancel: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────

let nextTempId = 1;
function tempId(): string {
  return `temp-${nextTempId++}`;
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
    broadcast_start: '',
    broadcast_end: '',
  };
}

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
];

const INITIAL_FORM: SeriesForm = {
  name: '',
  short_name: '',
  game: '',
  partner: '',
  start_date: '',
  end_date: '',
  discovery_keywords: '',
  status: 'draft',
  stages: [],
};

// ── Component ────────────────────────────────────────────────────────────

export function SeriesSetupPage({ onCreated, onCancel }: SeriesSetupPageProps) {
  const [form, setForm] = useState<SeriesForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

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
    setForm((prev) => ({
      ...prev,
      stages: prev.stages.filter((_, i) => i !== stageIdx).map((s, i) => ({ ...s, order: i + 1 })),
    }));
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
      stages[stageIdx] = {
        ...stage,
        broadcast_days: stage.broadcast_days.filter((_, i) => i !== dayIdx),
      };
      return { ...prev, stages };
    });
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
      // 1. Create series
      setProgress('Creating series...');
      const keywords = form.discovery_keywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);

      const series = await api.createSeries({
        name: form.name.trim(),
        short_name: form.short_name.trim() || undefined,
        game: form.game.trim() || undefined,
        partner: form.partner.trim() || undefined,
        status: form.status,
        start_date: form.start_date || undefined,
        end_date: form.end_date || undefined,
        discovery_keywords: keywords.length > 0 ? keywords : undefined,
      });

      // 2. Create stages sequentially
      for (let si = 0; si < form.stages.length; si++) {
        const stageForm = form.stages[si]!;
        setProgress(`Creating stage ${si + 1} of ${form.stages.length}...`);

        const stage = await api.createStage(series.id, {
          name: stageForm.name.trim() || `Stage ${stageForm.order}`,
          order: stageForm.order,
          start_date: stageForm.start_date || undefined,
          end_date: stageForm.end_date || undefined,
        });

        // 3. Create broadcast days for this stage
        for (let di = 0; di < stageForm.broadcast_days.length; di++) {
          const dayForm = stageForm.broadcast_days[di]!;
          setProgress(
            `Creating broadcast day ${di + 1} of ${stageForm.broadcast_days.length} for ${stageForm.name || `Stage ${stageForm.order}`}...`,
          );

          await api.createBroadcastDay(stage.id, {
            label: dayForm.label.trim() || `Day ${di + 1}`,
            date: dayForm.date,
            broadcast_start: dayForm.broadcast_start || undefined,
            broadcast_end: dayForm.broadcast_end || undefined,
          });
        }
      }

      setProgress('');
      onCreated(series.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setProgress('');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Timeline ─────────────────────────────────────────────────────────

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

    const stageBlocks = form.stages
      .filter((s) => s.start_date && s.end_date)
      .map((s) => ({
        label: s.name || `Stage ${s.order}`,
        left: toPercent(s.start_date),
        width: Math.max(2, toPercent(s.end_date) - toPercent(s.start_date)),
        days: s.broadcast_days
          .filter((d) => d.date)
          .map((d) => ({
            label: d.label,
            position: toPercent(d.date),
          })),
      }));

    return { stageBlocks };
  }, [form]);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Card
        title="New Tournament Series"
        subtitle="Configure the full tournament structure before an event"
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

            <FormField label="Status">
              <Select
                options={STATUS_OPTIONS}
                value={form.status}
                onChange={(e) => updateField('status', e.target.value as SeriesForm['status'])}
              />
            </FormField>
          </div>

          <FormField label="Discovery Keywords" className="max-w-lg">
            <TextArea
              value={form.discovery_keywords}
              onChange={(e) => updateField('discovery_keywords', e.target.value)}
              placeholder="Comma-separated: PEC, PUBG Championship, pubg esports"
              rows={2}
            />
          </FormField>
        </div>
      </Card>

      {/* Visual Timeline */}
      {timeline && timeline.stageBlocks.length > 0 && (
        <Card title="Timeline Preview">
          <div className="relative h-20">
            {/* Background bar */}
            <div className="absolute inset-x-0 top-4 h-2 rounded-full bg-navy-700" />

            {/* Stage blocks */}
            {timeline.stageBlocks.map((block, i) => (
              <div key={i}>
                {/* Stage bar */}
                <div
                  className="absolute top-3 h-4 rounded bg-clutch-red/20 border border-clutch-red/40"
                  style={{ left: `${block.left}%`, width: `${block.width}%` }}
                >
                  <span className="absolute -top-4 left-0 whitespace-nowrap text-[10px] text-gray-400">
                    {block.label}
                  </span>
                </div>

                {/* Day dots */}
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

            {/* Date labels */}
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
            Stages ({form.stages.length})
          </h3>
          <Button variant="primary" size="sm" onClick={addStage}>
            + Add Stage
          </Button>
        </div>

        {form.stages.length === 0 && (
          <Card>
            <p className="py-4 text-center text-sm text-gray-500">
              No stages yet. Click &quot;+ Add Stage&quot; to add tournament stages.
            </p>
          </Card>
        )}

        {form.stages.map((stage, si) => (
          <Card key={stage.tempId}>
            <div className="space-y-4">
              {/* Stage header */}
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-gray-300">
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

              {/* Stage fields */}
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
                    Broadcast Days ({stage.broadcast_days.length})
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => addDay(si)}>
                    + Day
                  </Button>
                </div>

                {stage.broadcast_days.length === 0 && (
                  <p className="py-2 text-center text-xs text-gray-600">
                    No broadcast days. Click &quot;+ Day&quot; to add one.
                  </p>
                )}

                <div className="space-y-2">
                  {stage.broadcast_days.map((day, di) => (
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
                        <FormField label="Start Time">
                          <TextInput
                            type="datetime-local"
                            value={day.broadcast_start}
                            onChange={(e) =>
                              updateDay(si, di, 'broadcast_start', e.target.value)
                            }
                          />
                        </FormField>
                        <FormField label="End Time">
                          <TextInput
                            type="datetime-local"
                            value={day.broadcast_end}
                            onChange={(e) =>
                              updateDay(si, di, 'broadcast_end', e.target.value)
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
                  ))}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

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
            Create Series
          </Button>
        </div>
      </div>
    </div>
  );
}
