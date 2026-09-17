#!/usr/bin/env npx tsx
/**
 * Live views from the command line: run the collector for days the hourly
 * job no longer reaches (it looks back 10 days), and load a views CSV read
 * by hand as `csv_import` rows.
 *
 * Usage:
 *   npx tsx scripts/views-collect.ts --series ggwc26                 # every completed day
 *   npx tsx scripts/views-collect.ts --day <broadcast_day uuid>
 *   npx tsx scripts/views-collect.ts --series ggwc26 --import views.csv [--read-at 2026-09-16]
 *   add --dry-run to --import to see the matching without writing
 *
 * CSV columns (header row): date, platform, channel, views_today, wc_share,
 * wc_share_method (full | time share | viewer-minutes), wc_views, note,
 * broadcast_minutes, tracked_minutes. Rows without views_today are skipped,
 * and so is Kick: its public number counts replays only, which never count.
 *
 * Only ever inserts or updates rows in stream_views / stream_views_runs.
 */
import fs from 'fs';
import db from '../src/utils/db';
import { AdapterRegistry } from '../src/adapters';
import { ViewsCollector } from '../src/services/views-collector';

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};
const DRY = process.argv.includes('--dry-run');

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
function parseCsv(text: string): Array<Record<string, string>> {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((c) => c !== '')) out.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c !== '')) out.push(row);
  const [header, ...body] = out;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const METHOD: Record<string, string> = { full: 'full', 'time share': 'time_share', 'viewer-minutes': 'viewer_minutes' };

async function main() {
  const seriesArg = arg('--series');
  const dayArg = arg('--day');
  const importFile = arg('--import');
  const readAt = arg('--read-at');
  if (!seriesArg && !dayArg) {
    console.error('Required: --series <short_name> or --day <broadcast_day uuid>');
    process.exit(1);
  }

  const dayQuery = db('broadcast_days as bd')
    .join('tournament_series as ts', 'ts.id', 'bd.series_id')
    .where('bd.status', 'completed')
    .orderBy('bd.date', 'asc')
    .select('bd.id', 'bd.label', 'bd.date', 'bd.series_id');
  if (dayArg) dayQuery.where('bd.id', dayArg);
  else dayQuery.whereRaw('lower(ts.short_name) = ?', [String(seriesArg).toLowerCase()]);
  const days = (await dayQuery) as Array<{ id: string; label: string; date: string | Date; series_id: string }>;
  if (days.length === 0) {
    console.error('No completed broadcast day matches');
    process.exit(1);
  }
  const dateOf = (d: string | Date) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

  if (!importFile) {
    const collector = new ViewsCollector(new AdapterRegistry(), db);
    for (const d of days) {
      const s = await collector.collectDay(d.id);
      console.log(`${dateOf(d.date)} ${d.label} [${s.pass}]: ${s.channels} channels, ${JSON.stringify(s.rowsBySource)}, ${s.missing.length} without a measured source`);
    }
    return;
  }

  const entries = parseCsv(fs.readFileSync(importFile, 'utf8'));
  const dayByDate = new Map(days.map((d) => [dateOf(d.date), d]));
  const channels = (await db('channels')
    .whereIn('series_id', [...new Set(days.map((d) => d.series_id))])
    .select('id', 'platform', 'display_name', 'series_id')) as Array<{ id: string; platform: string; display_name: string; series_id: string }>;
  const now = new Date();
  const rows: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];
  for (const e of entries) {
    const tag = `${e.date} ${e.platform} ${e.channel}`;
    if (!e.views_today) continue;
    if (e.platform === 'kick') {
      skipped.push(`${tag}: Kick replay views never count`);
      continue;
    }
    const day = dayByDate.get(e.date);
    if (!day) {
      skipped.push(`${tag}: no completed day on that date`);
      continue;
    }
    const match = channels.filter((c) => c.series_id === day.series_id && String(c.platform) === e.platform && c.display_name === e.channel);
    if (match.length !== 1) {
      skipped.push(`${tag}: ${match.length} channels with that name`);
      continue;
    }
    // A channel the tracker has no minutes for on that day is not part of the day.
    const tracked = await db('viewership_minute_rollup').where({ channel_id: match[0].id, broadcast_day_id: day.id }).where('ccv', '>', 0).first('channel_id');
    if (!tracked) {
      skipped.push(`${tag}: no tracked minutes on that day`);
      continue;
    }
    const views = Math.round(Number(e.views_today));
    const method = METHOD[e.wc_share_method] ?? 'full';
    const share = e.wc_share ? Number(e.wc_share) : 1;
    const eventViews = e.wc_views ? Math.round(Number(e.wc_views)) : views;
    if (!Number.isFinite(views) || !Number.isFinite(share) || !Number.isFinite(eventViews)) {
      skipped.push(`${tag}: not a number`);
      continue;
    }
    const full = await db('broadcast_days').where('id', day.id).first('stage_id');
    rows.push({
      channel_id: match[0].id,
      broadcast_day_id: day.id,
      series_id: day.series_id,
      stage_id: full?.stage_id ?? null,
      platform: e.platform,
      stream_ref: '',
      source: 'csv_import',
      snapshot: 'manual',
      views,
      counted: true,
      broadcast_minutes: e.broadcast_minutes ? Math.round(Number(e.broadcast_minutes)) : null,
      tracked_minutes: e.tracked_minutes ? Math.round(Number(e.tracked_minutes)) : null,
      event_share: Number(share.toFixed(4)),
      event_share_method: method,
      event_views: eventViews,
      confidence: method === 'full' ? 'measured' : 'adjusted',
      extra: JSON.stringify({ file: importFile.split('/').pop(), read_at: readAt }),
      note: [readAt ? `read by hand on ${readAt}, replay views up to then included` : 'read by hand', e.note].filter(Boolean).join('; '),
      fetched_at: now,
    });
  }

  console.log(`${entries.length} CSV rows, ${rows.length} to import, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skipped ${s}`);
  if (DRY || rows.length === 0) {
    console.log(DRY ? 'dry run, nothing written' : 'nothing to write');
    return;
  }
  await db.transaction(async (trx) => {
    for (let i = 0; i < rows.length; i += 200) {
      await trx('stream_views')
        .insert(rows.slice(i, i + 200))
        .onConflict(['channel_id', 'broadcast_day_id', 'source', 'snapshot', 'stream_ref'])
        .merge();
    }
  });
  console.log(`imported ${rows.length} rows`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
