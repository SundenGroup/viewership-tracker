/**
 * Per-tracker YouTube channel gating decisions.
 *
 * YouTube gives no reliable game association (topicDetails returns the same
 * generic topics for PUBG PC and PUBG Mobile), so membership in a tracker is
 * a human judgment we record once and reuse forever. Three states:
 *
 *   allow   — counts toward this tracker
 *   deny    — never counts (wrong game, mobile variant, clip farm…)
 *   pending — matched the keyword rules but nobody has confirmed it yet;
 *             it is NOT tracked, it sits in the review queue
 *
 * Keeping "pending" out of the data is deliberate: silently including
 * unreviewed channels is how a BGMI stream ends up in a PC tracker.
 */
import db from '../utils/db';

export type GatingDecision = 'allow' | 'deny' | 'pending';

/**
 * How much of an approved channel counts.
 *   matching — variety streamer: only streams matching this game's vocabulary
 *   all      — dedicated channel: everything they stream in Gaming
 */
export type GatingScope = 'matching' | 'all';

export interface GameTrackerYouTubeChannel {
  id: string;
  game_tracker_id: string;
  channel_identifier: string;
  display_name: string | null;
  decision: GatingDecision;
  scope: GatingScope;
  reason: string | null;
  sample_title: string | null;
  sample_video_id: string | null;
  sample_ccv: number | null;
  last_seen_at: Date | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const TABLE = 'game_tracker_youtube_channels';

export interface StoredDecision {
  decision: GatingDecision;
  /** True when a person decided it — only those are permanently binding. */
  human: boolean;
  /** Only meaningful for an approved channel; see GatingScope. */
  scope: GatingScope;
  /** Stored reason — carried forward on auto-deny pass-throughs so the
   *  original verdict stays auditable instead of being clobbered. */
  reason?: string | null;
  /** Last time a verdict was actually derived (auto) or made (human). */
  decidedAt?: Date | null;
  createdAt?: Date | null;
}

/**
 * Decisions for a tracker keyed by channel id (poll-cycle hot path).
 *
 * `human` matters: an automatic allow is provisional and gets re-checked
 * as a stream grows, whereas a human decision is final.
 */
export async function decisionMap(gameTrackerId: string): Promise<Map<string, StoredDecision>> {
  const rows = await db(TABLE)
    .where('game_tracker_id', gameTrackerId)
    .select('channel_identifier', 'decision', 'decided_by', 'scope', 'reason', 'decided_at', 'created_at');
  return new Map(
    rows.map((r) => [
      r.channel_identifier as string,
      {
        decision: r.decision as GatingDecision,
        human: r.decided_by != null,
        scope: (r.scope as GatingScope) ?? 'matching',
        reason: (r.reason as string | null) ?? null,
        decidedAt: (r.decided_at as Date | null) ?? null,
        createdAt: (r.created_at as Date | null) ?? null,
      },
    ]),
  );
}

export async function list(
  gameTrackerId: string,
  decision?: GatingDecision,
): Promise<GameTrackerYouTubeChannel[]> {
  const q = db(TABLE).where('game_tracker_id', gameTrackerId);
  if (decision) q.where('decision', decision);
  return q.orderBy([{ column: 'sample_ccv', order: 'desc', nulls: 'last' }, { column: 'last_seen_at', order: 'desc' }]);
}

export async function counts(gameTrackerId: string): Promise<Record<GatingDecision, number>> {
  const rows = await db(TABLE)
    .where('game_tracker_id', gameTrackerId)
    .select('decision')
    .count<{ decision: GatingDecision; count: string }[]>('* as count')
    .groupBy('decision');
  const out: Record<GatingDecision, number> = { allow: 0, deny: 0, pending: 0 };
  for (const r of rows) out[r.decision] = Number(r.count);
  return out;
}

/**
 * Record/refresh a candidate seen live. Existing decisions are never
 * overwritten — only the evidence (what they were streaming, when, how big)
 * is refreshed so the review queue shows current context.
 */
export async function observe(inputRows: Array<{
  gameTrackerId: string;
  channelIdentifier: string;
  displayName: string | null;
  decision: GatingDecision;
  reason: string | null;
  sampleTitle: string | null;
  sampleVideoId: string | null;
  sampleCcv: number | null;
  /** Set when this cycle derived a fresh verdict (null = pass-through of the
   *  stored one). Drives the auto-deny re-test clock. */
  decidedAt?: Date | null;
}>): Promise<void> {
  if (inputRows.length === 0) return;

  // A channel can run several simultaneous streams (esports channels do it
  // constantly: main + map view). That would put the same conflict key in
  // one INSERT twice, which Postgres rejects outright with "ON CONFLICT DO
  // UPDATE command cannot affect row a second time" — failing the WHOLE
  // batch, not just the duplicate. Collapse to one row per channel first,
  // keeping the biggest stream: it's the one that represents what the
  // channel is predominantly broadcasting.
  const byChannel = new Map<string, (typeof inputRows)[number]>();
  for (const r of inputRows) {
    const key = `${r.gameTrackerId}:${r.channelIdentifier}`;
    const prev = byChannel.get(key);
    if (!prev || (r.sampleCcv ?? 0) > (prev.sampleCcv ?? 0)) byChannel.set(key, r);
  }
  const rows = [...byChannel.values()];
  const now = new Date();
  await db.raw(
    `
    INSERT INTO ${TABLE}
      (game_tracker_id, channel_identifier, display_name, decision, reason,
       sample_title, sample_video_id, sample_ccv, last_seen_at, created_at, updated_at, decided_at)
    SELECT * FROM unnest(
      ?::uuid[], ?::text[], ?::text[], ?::text[], ?::text[],
      ?::text[], ?::text[], ?::int[], ?::timestamptz[], ?::timestamptz[], ?::timestamptz[], ?::timestamptz[]
    )
    ON CONFLICT (game_tracker_id, channel_identifier) DO UPDATE SET
      display_name  = COALESCE(EXCLUDED.display_name, ${TABLE}.display_name),
      sample_title  = COALESCE(EXCLUDED.sample_title, ${TABLE}.sample_title),
      sample_video_id = COALESCE(EXCLUDED.sample_video_id, ${TABLE}.sample_video_id),
      sample_ccv    = GREATEST(COALESCE(EXCLUDED.sample_ccv, 0), COALESCE(${TABLE}.sample_ccv, 0)),
      last_seen_at  = EXCLUDED.last_seen_at,
      updated_at    = EXCLUDED.updated_at,
      -- a human decision is final; only auto rows may be re-derived
      decision = CASE WHEN ${TABLE}.decided_by IS NULL THEN EXCLUDED.decision ELSE ${TABLE}.decision END,
      reason   = CASE WHEN ${TABLE}.decided_by IS NULL THEN EXCLUDED.reason ELSE ${TABLE}.reason END,
      -- auto rows: stamp when a fresh verdict was derived (re-test clock); human rows untouched
      decided_at = CASE WHEN ${TABLE}.decided_by IS NULL
                        THEN COALESCE(EXCLUDED.decided_at, ${TABLE}.decided_at)
                        ELSE ${TABLE}.decided_at END
    `,
    [
      rows.map((r) => r.gameTrackerId),
      rows.map((r) => r.channelIdentifier),
      rows.map((r) => r.displayName),
      rows.map((r) => r.decision),
      rows.map((r) => r.reason),
      rows.map((r) => r.sampleTitle),
      rows.map((r) => r.sampleVideoId),
      rows.map((r) => r.sampleCcv),
      rows.map(() => now),
      rows.map(() => now),
      rows.map(() => now),
      rows.map((r) => r.decidedAt ?? null),
    ],
  );
}

/** Admin decision — sticky (auto-gating will not overwrite it afterwards). */
export async function decide(
  gameTrackerId: string,
  channelIdentifier: string,
  decision: Exclude<GatingDecision, 'pending'>,
  decidedBy: string,
  note?: string,
  scope: GatingScope = 'matching',
): Promise<GameTrackerYouTubeChannel | null> {
  const [row] = await db(TABLE)
    .where({ game_tracker_id: gameTrackerId, channel_identifier: channelIdentifier })
    .update({
      decision,
      scope,
      decided_by: decidedBy,
      decided_at: new Date(),
      reason: note ?? `manual: ${decision}${decision === 'allow' && scope === 'all' ? ' (all streams)' : ''}`,
      updated_at: new Date(),
    })
    .returning('*');
  return (row as GameTrackerYouTubeChannel) ?? null;
}

/** Clear a decision back to the review queue (undo a mistaken allow/deny). */
export async function reset(gameTrackerId: string, channelIdentifier: string): Promise<void> {
  await db(TABLE)
    .where({ game_tracker_id: gameTrackerId, channel_identifier: channelIdentifier })
    .update({
      decision: 'pending',
      decided_by: null,
      decided_at: null,
      reason: 'reset to review',
      updated_at: new Date(),
    });
}

// ── Review queue paging ──────────────────────────────────────────────────

export interface ListPageOptions {
  decision?: GatingDecision;
  /** Substring match on channel name / identifier / sample title. */
  q?: string | null;
  /** Exact stored reason (one cluster from reasonClusters()). */
  reason?: string | null;
  minCcv?: number | null;
  limit: number;
  offset: number;
  sort?: 'ccv' | 'seen' | 'name';
}

/**
 * One page of the review queue with the total, so 195 pending rows are
 * not one endless list. Sorted by peak seen (desc) unless told otherwise.
 */
export async function listPage(
  gameTrackerId: string,
  opts: ListPageOptions,
): Promise<{ rows: GameTrackerYouTubeChannel[]; total: number }> {
  const base = db(TABLE).where('game_tracker_id', gameTrackerId);
  if (opts.decision) base.where('decision', opts.decision);
  if (opts.reason) base.where('reason', opts.reason);
  if (opts.minCcv != null && opts.minCcv > 0) base.where('sample_ccv', '>=', opts.minCcv);
  if (opts.q && opts.q.trim()) {
    const like = `%${opts.q.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
    base.where((qb) => {
      qb.whereILike('display_name', like)
        .orWhereILike('channel_identifier', like)
        .orWhereILike('sample_title', like);
    });
  }
  const countQ = base.clone().count<{ n: string }[]>('* as n');
  const rowsQ = base.clone();
  switch (opts.sort) {
    case 'seen':
      rowsQ.orderBy([{ column: 'last_seen_at', order: 'desc', nulls: 'last' }]);
      break;
    case 'name':
      rowsQ.orderByRaw('LOWER(COALESCE(display_name, channel_identifier)) ASC');
      break;
    default:
      rowsQ.orderBy([
        { column: 'sample_ccv', order: 'desc', nulls: 'last' },
        { column: 'last_seen_at', order: 'desc' },
      ]);
  }
  rowsQ.limit(opts.limit).offset(opts.offset);
  const [countRows, rows] = await Promise.all([countQ, rowsQ]);
  return { rows, total: Number(countRows[0]?.n ?? 0) };
}

/**
 * Distinct stored reasons for one decision bucket with their counts —
 * the review queue's reason filter and the "apply to all with this
 * reason" bulk action are built on it.
 */
export async function reasonClusters(
  gameTrackerId: string,
  decision: GatingDecision,
): Promise<Array<{ reason: string; count: number }>> {
  const rows = await db(TABLE)
    .where({ game_tracker_id: gameTrackerId, decision })
    .whereNotNull('reason')
    .select('reason')
    .count<{ reason: string; count: string }[]>('* as count')
    .groupBy('reason')
    .orderBy('count', 'desc');
  return rows.map((r) => ({ reason: r.reason, count: Number(r.count) }));
}

/** Channel identifiers for every row in a decision bucket with this reason (bulk actions). */
export async function identifiersForReason(
  gameTrackerId: string,
  decision: GatingDecision,
  reason: string,
): Promise<string[]> {
  return db(TABLE)
    .where({ game_tracker_id: gameTrackerId, decision, reason })
    .orderBy([{ column: 'sample_ccv', order: 'desc', nulls: 'last' }])
    .pluck('channel_identifier');
}
