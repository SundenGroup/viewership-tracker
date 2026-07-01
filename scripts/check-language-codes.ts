#!/usr/bin/env npx tsx
/**
 * Language-code lint — reports channels whose language tag is not the
 * canonical form normalizeLanguageCode() would produce (alias mistakes
 * like ua→uk, region subtags like en-US, casing) plus blank languages on
 * channels that have viewership data.
 *
 * Read-only. Prints suggested UPDATE statements; never executes them —
 * language relabels also touch historical snapshot rows, so apply by hand
 * after review (see the retroactive-update logic in channels.ts PUT).
 *
 * Run on the server:
 *   cd /opt/clutch-viewership-tracker
 *   npx tsx scripts/check-language-codes.ts               # all series
 *   npx tsx scripts/check-language-codes.ts <series-id>   # one series
 */
import knex from 'knex';
import { config } from '../src/utils/config';
import { normalizeLanguageCode } from '../src/utils/language';

async function main() {
  const seriesFilter = process.argv[2];
  const db = knex({ client: 'pg', connection: config.database.url });
  try {
    let q = db('channels as c')
      .join('tournament_series as ts', 'ts.id', 'c.series_id')
      .select(
        'c.id',
        'c.series_id',
        'ts.name as series_name',
        'c.platform',
        'c.channel_identifier',
        'c.display_name',
        'c.language',
        'c.is_active',
      );
    if (seriesFilter) q = q.where('c.series_id', seriesFilter);
    const rows = await q;

    interface Issue {
      kind: 'alias' | 'blank';
      row: (typeof rows)[number];
      suggested: string | null;
      snapshots: number;
    }
    const issues: Issue[] = [];

    for (const row of rows) {
      const lang = row.language as string | null;
      const norm = normalizeLanguageCode(lang);
      if (lang && norm !== lang) {
        const [{ count }] = await db('viewership_snapshots')
          .where('channel_id', row.id)
          .count<{ count: string }[]>('* as count');
        issues.push({ kind: 'alias', row, suggested: norm, snapshots: parseInt(count, 10) });
      } else if (!lang) {
        const [{ count }] = await db('viewership_snapshots')
          .where('channel_id', row.id)
          .count<{ count: string }[]>('* as count');
        const n = parseInt(count, 10);
        // Blank language only matters once the channel has data — it
        // falls out of every per-language rollup.
        if (n > 0) issues.push({ kind: 'blank', row, suggested: null, snapshots: n });
      }
    }

    if (issues.length === 0) {
      console.log(`All ${rows.length} channels carry canonical language codes. ✓`);
      return;
    }

    console.log(`${issues.length} channel(s) need attention (of ${rows.length} checked):\n`);
    for (const i of issues) {
      const r = i.row;
      if (i.kind === 'alias') {
        console.log(
          `  ALIAS  ${r.series_name} · ${r.platform}/${r.channel_identifier} (${r.display_name})` +
            `  '${r.language}' → '${i.suggested}'  [${i.snapshots} snapshots]`,
        );
        console.log(
          `         UPDATE channels SET language='${i.suggested}' WHERE id='${r.id}';` +
            ` UPDATE viewership_snapshots SET language='${i.suggested}' WHERE channel_id='${r.id}';`,
        );
      } else {
        console.log(
          `  BLANK  ${r.series_name} · ${r.platform}/${r.channel_identifier} (${r.display_name})` +
            `  language not set  [${i.snapshots} snapshots — excluded from language rollups]`,
        );
      }
    }
    console.log(
      '\nNothing was modified. Review and run the UPDATEs manually (they also relabel historical snapshots).',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
