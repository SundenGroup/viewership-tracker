#!/usr/bin/env npx tsx
/**
 * One-off backfill of SOOP profile pictures.
 *
 * SOOP avatars are addressable from the station id alone, so this needs
 * no API key and no relay. Every id returns HTTP 200 though — SOOP
 * serves a generic placeholder for stations with no picture — so each
 * candidate gets a HEAD request and is stored only when the asset is
 * something other than that fixed-size placeholder. Storing the
 * placeholder would swap a legible monogram for an identical grey
 * silhouette across every Korean channel.
 *
 * Idempotent: channels that already have profile_image_url are skipped,
 * so re-running only picks up what's still missing.
 *
 *   npx tsx scripts/backfill-soop-avatars.ts [--limit N] [--dry-run]
 */
import axios from 'axios';
import db from '../src/utils/db';
import { soopAvatarUrl, SOOP_DEFAULT_AVATAR_BYTES } from '../src/services/game-tracker-service';

const DRY = process.argv.includes('--dry-run');
const limArg = process.argv.indexOf('--limit');
const LIMIT = limArg === -1 ? 100_000 : Number(process.argv[limArg + 1]);
/** Be a polite guest on an endpoint nobody promised us. */
const GAP_MS = 120;

async function main() {
  const rows = await db('channels')
    .where('platform', 'soop')
    .whereRaw(`COALESCE(metadata->>'profile_image_url', '') = ''`)
    .select('id', 'channel_identifier')
    .limit(LIMIT);

  console.log(`SOOP avatar backfill: ${rows.length} channel(s) without a picture${DRY ? ' (dry run)' : ''}`);
  let stored = 0;
  let placeholder = 0;
  let failed = 0;

  for (const [i, row] of rows.entries()) {
    const id = String(row.channel_identifier).toLowerCase();
    const url = soopAvatarUrl(id);
    try {
      const head = await axios.head(url, {
        timeout: 6_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        validateStatus: (s) => s === 200,
      });
      const bytes = Number(head.headers['content-length'] ?? 0);
      if (bytes === SOOP_DEFAULT_AVATAR_BYTES || bytes === 0) {
        placeholder++;
      } else {
        if (!DRY) {
          await db('channels')
            .where('id', row.id)
            .update({
              metadata: db.raw(`COALESCE(metadata,'{}'::jsonb) || ?::jsonb`, [
                JSON.stringify({ profile_image_url: url }),
              ]),
            });
        }
        stored++;
      }
    } catch {
      failed++;
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  ${i + 1}/${rows.length} — stored ${stored}, placeholder ${placeholder}, failed ${failed}`);
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  console.log(`Done — stored ${stored}, placeholder-only ${placeholder}, unreachable ${failed}`);
  await db.destroy();
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await db.destroy();
  process.exit(1);
});
