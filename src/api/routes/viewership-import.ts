/**
 * Admin CSV import — replace a channel's viewership data for one broadcast
 * day from an official platform export.
 *
 * Mirrors the manual "official CSV" workflow used during PNC2026: parse the
 * platform's CSV (12h/24h local times), convert to UTC, DELETE the channel's
 * existing snapshots in the covered range, INSERT the official values.
 *
 * Supported CSV shapes (header-detected, column order doesn't matter):
 *   - Twitch "Stream Session" export:  Timestamp ("10:30 AM"), Average Viewers
 *   - YouTube analytics export:        Date time / Time, Concurrent viewers
 *   - Generic:                         any time-ish column + any viewers-ish column
 *
 * Times without a date part (Twitch) need the `date` param; all local times
 * are interpreted in `timezone` (IANA, default Europe/Berlin) and converted
 * DST-safely to UTC.
 *
 * Always call with dryRun=true first — the response previews the parsed
 * range and how many existing rows the commit would replace. The commit
 * uses the SAME predicate the preview reported.
 */
import { Router, Request, Response, NextFunction } from 'express';
import db from '../../utils/db';
import logger from '../../utils/logger';

const router = Router();

// ── CSV parsing ──────────────────────────────────────────────────────────

/** Minimal CSV parser with quoted-field support. Returns rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function detectColumns(headers: string[]): { timeIdx: number; viewersIdx: number } | null {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const timeIdx = norm.findIndex((h) =>
    /^(timestamp|time|date ?time|datetime|date)$/.test(h) || /^time \(/.test(h),
  );
  // Prefer the platform-official columns; fall back to anything viewer-ish
  // that isn't "live views" (Twitch's cumulative view count).
  let viewersIdx = norm.findIndex((h) => h === 'average viewers' || h === 'concurrent viewers');
  if (viewersIdx === -1) {
    viewersIdx = norm.findIndex((h) => /^(viewers|ccv|concurrent_viewers)$/.test(h));
  }
  if (timeIdx === -1 || viewersIdx === -1) return null;
  return { timeIdx, viewersIdx };
}

// ── Time handling ────────────────────────────────────────────────────────

interface ParsedTime {
  /** 'YYYY-MM-DD' when the cell carried its own date, else null. */
  date: string | null;
  h: number;
  m: number;
  s: number;
  /** True when the cell was an explicit UTC instant (trailing Z). */
  utc: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseTimeCell(raw: string): ParsedTime | null {
  const t = raw.trim();
  if (!t) return null;

  // ISO-ish: 2026-06-28T13:30[:45][Z] or 2026-06-28 13:30[:45]
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(Z)?/i);
  if (m) {
    return {
      date: `${m[1]}-${m[2]}-${m[3]}`,
      h: parseInt(m[4], 10),
      m: parseInt(m[5], 10),
      s: m[6] ? parseInt(m[6], 10) : 0,
      utc: !!m[7],
    };
  }

  // YouTube analytics style: "Jun 28, 2026, 1:00:00 PM" (comma variants)
  m = t.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!mo) return null;
    let h = parseInt(m[4], 10);
    const ap = m[7]?.toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return {
      date: `${m[3]}-${String(mo).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`,
      h,
      m: parseInt(m[5], 10),
      s: m[6] ? parseInt(m[6], 10) : 0,
      utc: false,
    };
  }

  // Bare clock time: "10:30 AM", "1:05:30 PM", "13:30", "13:30:45"
  m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = m[4]?.toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return { date: null, h, m: parseInt(m[2], 10), s: m[3] ? parseInt(m[3], 10) : 0, utc: false };
  }

  return null;
}

/** Minutes east of UTC for an IANA timezone at a given UTC instant. */
function tzOffsetMinutes(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  }
  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second,
  );
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Convert local wall-clock time in an IANA tz to a UTC Date (DST-safe). */
function zonedToUtc(dateStr: string, h: number, m: number, s: number, timeZone: string): Date {
  const [y, mo, d] = dateStr.split('-').map((v) => parseInt(v, 10));
  const guess = Date.UTC(y, mo - 1, d, h, m, s);
  // Two-pass: offset at the guess, then re-evaluate at the corrected instant
  // so times right at a DST transition resolve to the correct side.
  const off1 = tzOffsetMinutes(timeZone, guess);
  const corrected = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(timeZone, corrected);
  return new Date(guess - off2 * 60_000);
}

function parseViewersCell(raw: string): number | null {
  const t = raw.trim().replace(/[,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** 'HH:MM' → minutes since local midnight, for the optional bounds. */
function hhmmToMinutes(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// ── Route ────────────────────────────────────────────────────────────────

interface ImportBody {
  channelId?: string;
  broadcastDayId?: string;
  csvText?: string;
  date?: string;
  timezone?: string;
  startTime?: string;
  endTime?: string;
  dryRun?: boolean;
}

router.post('/csv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      channelId,
      broadcastDayId,
      csvText,
      date,
      timezone = 'Europe/Berlin',
      startTime,
      endTime,
      dryRun = true,
    } = (req.body ?? {}) as ImportBody;

    if (!channelId || !broadcastDayId || !csvText) {
      res.status(400).json({ error: 'channelId, broadcastDayId and csvText are required' });
      return;
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      return;
    }
    try {
      // Validates the IANA name early (throws RangeError on bad input).
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      res.status(400).json({ error: `Unknown timezone: ${timezone}` });
      return;
    }

    const channel = await db('channels')
      .where('id', channelId)
      .first('id', 'series_id', 'platform', 'channel_identifier', 'display_name', 'language', 'region');
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const day = await db('broadcast_days')
      .where('id', broadcastDayId)
      .first('id', 'series_id', 'stage_id', 'label');
    if (!day) {
      res.status(404).json({ error: 'Broadcast day not found' });
      return;
    }
    if (day.series_id !== channel.series_id) {
      res.status(400).json({ error: 'Channel and broadcast day belong to different series' });
      return;
    }

    // ── Parse ──
    const table = parseCsv(csvText);
    if (table.length < 2) {
      res.status(400).json({ error: 'CSV has no data rows' });
      return;
    }
    const cols = detectColumns(table[0]);
    if (!cols) {
      res.status(400).json({
        error:
          'Could not detect columns. Need a time column (Timestamp / Time / Date time) ' +
          'and a viewers column (Average Viewers / Concurrent viewers / Viewers). ' +
          `Found headers: ${table[0].join(', ')}`,
      });
      return;
    }

    const warnings: string[] = [];
    let skipped = 0;
    const startMin = hhmmToMinutes(startTime);
    const endMin = hhmmToMinutes(endTime);
    // timestamp-ms -> viewers (last value wins for duplicate times)
    const byTs = new Map<number, number>();
    let needsDateParam = false;

    for (let i = 1; i < table.length; i++) {
      const rawTime = table[i][cols.timeIdx] ?? '';
      const rawViewers = table[i][cols.viewersIdx] ?? '';
      const pt = parseTimeCell(rawTime);
      const viewers = parseViewersCell(rawViewers);
      if (!pt || viewers === null) {
        skipped++;
        if (warnings.length < 5) warnings.push(`Row ${i + 1}: could not parse "${rawTime}" / "${rawViewers}"`);
        continue;
      }
      const rowDate = pt.date ?? date ?? null;
      if (!rowDate) {
        needsDateParam = true;
        break;
      }
      // Optional local-time window (e.g. "only from 11:00")
      const localMin = pt.h * 60 + pt.m;
      if (startMin !== null && localMin < startMin) { skipped++; continue; }
      if (endMin !== null && localMin > endMin) { skipped++; continue; }

      const ts = pt.utc
        ? Date.UTC(
            parseInt(rowDate.slice(0, 4), 10),
            parseInt(rowDate.slice(5, 7), 10) - 1,
            parseInt(rowDate.slice(8, 10), 10),
            pt.h, pt.m, pt.s,
          )
        : zonedToUtc(rowDate, pt.h, pt.m, pt.s, timezone).getTime();
      byTs.set(ts, viewers);
    }

    if (needsDateParam) {
      res.status(400).json({
        error:
          'The CSV times have no date part (e.g. "10:30 AM"). ' +
          'Pass the broadcast date as date=YYYY-MM-DD.',
      });
      return;
    }
    if (byTs.size === 0) {
      res.status(400).json({ error: 'No usable rows after parsing/filtering', skipped, warnings });
      return;
    }

    const points = [...byTs.entries()]
      .map(([ts, viewers]) => ({ ts, viewers }))
      .sort((a, b) => a.ts - b.ts);
    const fromUtc = new Date(points[0].ts);
    const toUtc = new Date(points[points.length - 1].ts);

    // Existing rows the commit would replace — SAME predicate as the delete.
    const existing = await db('viewership_snapshots')
      .where('channel_id', channel.id)
      .where('broadcast_day_id', day.id)
      .whereBetween('timestamp', [fromUtc, toUtc])
      .count<{ count: string }[]>('* as count');
    const existingRows = parseInt(existing[0]?.count ?? '0', 10);

    const fmtLocal = (dt: Date) =>
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(dt);

    const summary = {
      channel: {
        id: channel.id,
        identifier: channel.channel_identifier,
        displayName: channel.display_name,
        platform: channel.platform,
      },
      day: { id: day.id, label: day.label },
      parsed: points.length,
      skipped,
      warnings,
      timezone,
      range: {
        fromUtc: fromUtc.toISOString(),
        toUtc: toUtc.toISOString(),
        fromLocal: fmtLocal(fromUtc),
        toLocal: fmtLocal(toUtc),
      },
      existingRowsInRange: existingRows,
      sample: {
        first: points.slice(0, 3).map((p) => ({ t: new Date(p.ts).toISOString(), v: p.viewers })),
        last: points.slice(-3).map((p) => ({ t: new Date(p.ts).toISOString(), v: p.viewers })),
      },
    };

    if (dryRun) {
      res.json({ dryRun: true, ...summary });
      return;
    }

    // ── Commit: delete + insert in one transaction ──
    const insertRows = points.map((p) => ({
      channel_id: channel.id,
      broadcast_day_id: day.id,
      stage_id: day.stage_id,
      series_id: day.series_id,
      timestamp: new Date(p.ts),
      concurrent_viewers: p.viewers,
      platform: channel.platform,
      language: channel.language,
      region: channel.region,
      stream_id: null,
      stream_title: null,
    }));

    let deleted = 0;
    await db.transaction(async (trx) => {
      // The minute-rollup trigger recomputes per-statement; give bulk
      // replaces room on databases with a conservative statement_timeout.
      await trx.raw('SET LOCAL statement_timeout = 0');
      deleted = await trx('viewership_snapshots')
        .where('channel_id', channel.id)
        .where('broadcast_day_id', day.id)
        .whereBetween('timestamp', [fromUtc, toUtc])
        .delete();
      await trx.batchInsert('viewership_snapshots', insertRows, 500);
    });

    const user = (req as Request & { user?: { username?: string } }).user;
    logger.info(
      `[Import] CSV replace by ${user?.username ?? 'unknown'}: ` +
        `${channel.platform}/${channel.channel_identifier} on "${day.label}" — ` +
        `deleted ${deleted}, inserted ${insertRows.length} ` +
        `(${summary.range.fromLocal} → ${summary.range.toLocal} ${timezone})`,
    );

    res.json({ dryRun: false, ...summary, deleted, inserted: insertRows.length });
  } catch (err) {
    next(err);
  }
});

export default router;
