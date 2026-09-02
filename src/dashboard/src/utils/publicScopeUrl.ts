/**
 * Shareable public URLs — mirror the public page's scope into the query
 * string so the address bar is always a deep link:
 *
 *   /public/PGSC3                      default (live day if any, else series)
 *   /public/PGSC3?day=2026-08-20       a specific broadcast day (by date)
 *   /public/PGSC3?stage=pgs9           a stage (by slugified name)
 *   /public/PGSC3?scope=series         full series, even while a day is live
 *   …&group=West                       a view group on top of any of those
 *
 * Ids are accepted on read too (?day=<uuid>, ?stage=<uuid>). Writes use
 * history.replaceState — no navigation, no router involvement.
 */

export type ScopeSeriesShape = {
  stages: Array<{
    id: string;
    name: string;
    broadcast_days: Array<{ id: string; date: string | Date }>;
  }>;
  viewGroups?: Array<{ name: string }> | null;
};

export interface PublicScopeState {
  scopeLevel: 'series' | 'stage' | 'day';
  stageId: string | null;
  dayId: string | null;
  viewGroup: string;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const dateKey = (d: string | Date): string =>
  (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/** Parse the current URL into (partial) scope state. Unknown values are ignored. */
export function readScopeFromUrl(series: ScopeSeriesShape): Partial<PublicScopeState> {
  if (typeof window === 'undefined') return {};
  const p = new URLSearchParams(window.location.search);
  const out: Partial<PublicScopeState> = {};

  const group = p.get('group');
  if (group && (series.viewGroups ?? []).some((g) => g.name === group)) out.viewGroup = group;

  const day = p.get('day');
  if (day) {
    for (const s of series.stages) {
      for (const d of s.broadcast_days) {
        if (d.id === day || dateKey(d.date) === day) {
          return { ...out, scopeLevel: 'day', stageId: s.id, dayId: d.id };
        }
      }
    }
  }
  const stage = p.get('stage');
  if (stage) {
    const s = series.stages.find((x) => x.id === stage || slugify(x.name) === slugify(stage));
    if (s) return { ...out, scopeLevel: 'stage', stageId: s.id, dayId: null };
  }
  if (p.get('scope') === 'series') out.scopeLevel = 'series';
  return out;
}

/**
 * Mirror scope state into the URL. `defaultDayId` is the day the page would
 * show with no params at all (the live day) — when the state equals that
 * default the URL stays bare, so a copied link keeps following "whatever
 * is live" rather than pinning today's date forever.
 */
export function writeScopeToUrl(
  series: ScopeSeriesShape,
  st: PublicScopeState,
  opts: { defaultDayId: string | null },
): void {
  if (typeof window === 'undefined') return;
  const p = new URLSearchParams(window.location.search);
  p.delete('stage');
  p.delete('day');
  p.delete('scope');
  p.delete('group');

  if (st.scopeLevel === 'day' && st.dayId && st.dayId !== opts.defaultDayId) {
    const d = series.stages.flatMap((s) => s.broadcast_days).find((x) => x.id === st.dayId);
    if (d) p.set('day', dateKey(d.date));
  } else if (st.scopeLevel === 'stage' && st.stageId) {
    const s = series.stages.find((x) => x.id === st.stageId);
    if (s) p.set('stage', slugify(s.name));
  } else if (st.scopeLevel === 'series' && opts.defaultDayId) {
    // Only meaningful while a live day would otherwise be the default.
    p.set('scope', 'series');
  }
  if (st.viewGroup && st.viewGroup !== 'all') p.set('group', st.viewGroup);

  const qs = p.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(window.history.state, '', next);
}
