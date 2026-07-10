#!/usr/bin/env npx tsx
/**
 * Chat Metrics Collector — counts chat messages + unique chatters per minute
 * for the most-viewed LIVE channels currently followed by the game trackers,
 * and upserts them into chat_minute_rollup.
 *
 * Standalone, pm2-managed like the relay scripts. Talks straight to Postgres.
 *
 *   Twitch  ONE anonymous IRC connection (justinfan…) over TLS. JOINs the
 *           selected channels staggered (≤15 per 10s), counts PRIVMSG lines
 *           per #channel. PING/PONG handled; reconnect with backoff rejoins
 *           everything; JOIN failures are tolerated silently.
 *
 *   Kick    ONE Pusher WebSocket (Kick's public app key). Subscribes
 *           chatrooms.{id}.v2 per channel and counts
 *           App\Events\ChatMessageEvent frames. Chatroom ids are fetched
 *           once from kick.com/api/v2/channels/{slug} and cached in
 *           channels.metadata.kick_chatroom_id; a 403 there (datacenter
 *           block) is logged once and the channel is skipped this session.
 *
 * Channel selection (every 2 min): for all game_trackers with
 * status='active', take the channels seen live in game_tracker_snapshots in
 * the last 5 minutes with their latest CCV, keep platforms twitch|kick,
 * and drop anything below the CCV floor (CHAT_MIN_CCV, default 5 — low on
 * purpose: capture nearly everyone). Each tracker is then guaranteed
 * min(CHAT_TRACKER_QUOTA, its live channel count) slots for its top
 * channels — so a small tracker isn't starved by a giant one — and the
 * remainder is filled globally by CCV up to N (CHAT_MAX_CHANNELS, default
 * 600). Channels that drop out of the selection stay subscribed for a
 * 5-minute grace period before being parted/unsubscribed.
 *
 * Rollup flush (every 60s, aligned just after the minute boundary): one
 * batched upsert per flush —
 *   INSERT INTO chat_minute_rollup (channel_id, minute, messages, chatters)
 *   VALUES … ON CONFLICT (channel_id, minute) DO UPDATE
 *     SET messages = chat_minute_rollup.messages + EXCLUDED.messages,
 *         chatters = GREATEST(chat_minute_rollup.chatters, EXCLUDED.chatters)
 * chatters = size of that minute's unique-sender set. Only the current and
 * previous minute's sets live in memory (completed minutes flush and drop).
 *
 * Usage:
 *   npx tsx scripts/chat-collector.ts
 *   pm2 start "npx tsx scripts/chat-collector.ts" --name chat-collector
 *
 * Environment (from .env or shell):
 *   DATABASE_URL       — Postgres connection string (required)
 *   CHAT_MAX_CHANNELS  — global top-N channels to watch (default 600)
 *   CHAT_MIN_CCV       — ignore channels below this CCV (default 5)
 *   CHAT_TRACKER_QUOTA — guaranteed selection slots per active tracker
 *                        (default 50)
 *   KICK_PUSHER_KEY    — Kick's public Pusher app key (default baked in;
 *                        override when Kick rotates it)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import axios from 'axios';
import knex from 'knex';
import type { Knex } from 'knex';
import WebSocket from 'ws';
import { parsePrivmsg, parsePusherFrame, extractKickChat } from './lib/chat-parse';

// ── Load .env ─────────────────────────────────────────────────────────────

const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Config ────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || '';
const CHAT_MAX_CHANNELS = clampInt(process.env.CHAT_MAX_CHANNELS, 600, 1, 2000);
// CCV floor — channels below this never get selected. Deliberately LOW
// (capture nearly everyone); raise it if connection counts get heavy.
const CHAT_MIN_CCV = clampInt(process.env.CHAT_MIN_CCV, 5, 0, 1_000_000);
// Per-tracker fairness: each active tracker is guaranteed
// min(CHAT_TRACKER_QUOTA, its live channel count) slots before the
// remainder fills globally by CCV.
const CHAT_TRACKER_QUOTA = clampInt(process.env.CHAT_TRACKER_QUOTA, 50, 0, 2000);
// Kick's public Pusher app key (same for every visitor) — overridable for
// the day they rotate it.
const KICK_PUSHER_KEY = process.env.KICK_PUSHER_KEY || '32cbd69e4b950bf97679';

const SELECTION_INTERVAL_MS = 2 * 60_000; // channel selection loop
const LIVE_WINDOW_MINUTES = 5;            // "seen live in the last 5 minutes"
const GRACE_MS = 5 * 60_000;              // keep dropped-out channels this long
const FLUSH_LAG_MS = 1_500;               // flush this long after each minute boundary

const TWITCH_IRC_HOST = 'irc.chat.twitch.tv';
const TWITCH_IRC_PORT = 6697;
const JOIN_PUMP_INTERVAL_MS = 10_000;     // Twitch JOIN stagger window…
const JOIN_MAX_PER_PUMP = 15;             // …and max JOINs per window

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;
const IRC_IDLE_PING_MS = 6 * 60_000;      // Twitch pings ~every 5 min; nudge after 6
const IRC_IDLE_RECONNECT_MS = 8 * 60_000;
const PUSHER_IDLE_PING_MS = 60_000;       // Pusher activity timeout is ~120s
const PUSHER_IDLE_RECONNECT_MS = 180_000;

const KICK_RESOLVE_MAX_PER_CYCLE = 25;    // chatroom-id lookups per selection cycle
const KICK_RESOLVE_DELAY_MS = 300;

const PENDING_RETRY_MAX = 5_000;          // failed-flush rows kept for retry

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TWITCH_LOGIN_RE = /^[a-z0-9_]{1,32}$/;
const KICK_SLUG_RE = /^[a-z0-9_-]{1,64}$/;

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [Chat] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Database ──────────────────────────────────────────────────────────────

const db: Knex = knex({
  client: 'pg',
  connection: DATABASE_URL,
  pool: { min: 0, max: 4 },
});

// ── Per-minute accumulator ────────────────────────────────────────────────
// channel_id → minute-start epoch ms → { messages, unique sender set }.
// Messages only ever land in the *current* minute, and the flusher removes
// completed minutes every 60s, so at most the current + previous minute's
// sets are held per channel.

interface MinuteBucket {
  messages: number;
  chatters: Set<string>;
}

const buckets = new Map<string, Map<number, MinuteBucket>>();

function recordMessage(channelId: string, sender: string): void {
  const minuteMs = Math.floor(Date.now() / 60_000) * 60_000;
  let perMinute = buckets.get(channelId);
  if (!perMinute) {
    perMinute = new Map();
    buckets.set(channelId, perMinute);
  }
  let bucket = perMinute.get(minuteMs);
  if (!bucket) {
    bucket = { messages: 0, chatters: new Set() };
    perMinute.set(minuteMs, bucket);
  }
  bucket.messages++;
  bucket.chatters.add(sender);
}

// ── Twitch: one anonymous IRC connection ──────────────────────────────────

class TwitchIrc {
  private socket: tls.TLSSocket | null = null;
  private buffer = '';
  private ready = false;           // received 001 welcome
  private closing = false;
  private joined = new Set<string>();    // logins JOINed on the current socket
  private joinQueue: string[] = [];
  private desired = new Set<string>();   // logins we should be in
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private joinPumpTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();
  private lastPumpAt = 0;
  private readonly nick = `justinfan${Math.floor(10_000 + Math.random() * 890_000)}`;

  constructor(private readonly onChat: (login: string, nick: string) => void) {}

  start(): void {
    this.connect();
    this.joinPumpTimer = setInterval(() => {
      try {
        this.pumpJoins();
      } catch (err) {
        log(`twitch join pump error: ${errMsg(err)}`);
      }
    }, JOIN_PUMP_INTERVAL_MS);
    this.livenessTimer = setInterval(() => {
      try {
        this.checkLiveness();
      } catch {
        /* never throw out of a timer */
      }
    }, 30_000);
  }

  stop(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.joinPumpTimer) clearInterval(this.joinPumpTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    try {
      this.socket?.destroy();
    } catch {
      /* noop */
    }
    this.socket = null;
  }

  stats(): { joined: number; desired: number; connected: boolean } {
    return { joined: this.joined.size, desired: this.desired.size, connected: this.ready };
  }

  /** Sync the JOINed set to `logins`: queue JOINs for new ones, PART removed ones. */
  setDesired(logins: Set<string>): void {
    for (const login of logins) {
      if (!this.desired.has(login)) {
        this.desired.add(login);
        if (!this.joined.has(login)) this.joinQueue.push(login);
      }
    }
    for (const login of [...this.desired]) {
      if (!logins.has(login)) {
        this.desired.delete(login);
        if (this.joined.has(login)) {
          this.send(`PART #${login}`);
          this.joined.delete(login);
        }
        // If it was only queued, the pump skips non-desired logins.
      }
    }
  }

  private connect(): void {
    if (this.closing) return;
    this.buffer = '';
    this.ready = false;

    const socket = tls.connect({
      host: TWITCH_IRC_HOST,
      port: TWITCH_IRC_PORT,
      servername: TWITCH_IRC_HOST,
    });
    this.socket = socket;
    socket.setEncoding('utf8');

    socket.on('secureConnect', () => {
      this.lastActivity = Date.now();
      // Anonymous read-only login — no PASS, no capabilities needed for PRIVMSG.
      socket.write(`NICK ${this.nick}\r\n`);
      log(`twitch IRC connected as ${this.nick} — waiting for welcome`);
    });

    socket.on('data', (chunk: string | Buffer) => {
      this.lastActivity = Date.now();
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        if (line) this.handleLine(line);
      }
      // Safety valve: never let a malformed peer grow one endless "line".
      if (this.buffer.length > 1_000_000) this.buffer = '';
    });

    socket.on('error', (err: Error) => {
      log(`twitch IRC socket error: ${err.message}`);
      // 'close' follows and handles the reconnect.
    });

    socket.on('close', () => {
      if (this.closing) return;
      this.ready = false;
      this.socket = null;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
      log(`twitch IRC disconnected — reconnecting in ${Math.round(delay / 1000)}s`);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private handleLine(line: string): void {
    // Hot path first: chat messages.
    const msg = parsePrivmsg(line);
    if (msg) {
      this.onChat(msg.channel, msg.nick);
      return;
    }

    if (line.startsWith('PING')) {
      this.send(`PONG${line.slice(4)}`);
      return;
    }

    if (line.startsWith(':tmi.twitch.tv 001 ')) {
      // Welcome — safe to JOIN now. Rejoin everything we want (fresh socket
      // means fresh JOIN rate-limit budget, so pump immediately).
      this.ready = true;
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.joined.clear();
      this.joinQueue = [...this.desired];
      this.lastPumpAt = 0;
      log(`twitch IRC ready — ${this.joinQueue.length} channel(s) queued to join`);
      this.pumpJoins();
      return;
    }

    if (line.startsWith(':tmi.twitch.tv RECONNECT')) {
      log('twitch IRC requested RECONNECT — cycling connection');
      this.socket?.destroy();
      return;
    }

    // Everything else (JOIN/PART echoes, NOTICEs, numerics) is intentionally
    // ignored — JOIN failures are tolerated silently.
  }

  private pumpJoins(): void {
    if (!this.ready || !this.socket) return;
    const now = Date.now();
    // Rate gate: ≤ JOIN_MAX_PER_PUMP JOINs per JOIN_PUMP_INTERVAL_MS window
    // on a given connection (001 resets lastPumpAt — new socket, new budget).
    if (now - this.lastPumpAt < JOIN_PUMP_INTERVAL_MS - 250) return;
    let sent = 0;
    while (sent < JOIN_MAX_PER_PUMP && this.joinQueue.length > 0) {
      const login = this.joinQueue.shift()!;
      if (!this.desired.has(login) || this.joined.has(login)) continue;
      this.send(`JOIN #${login}`);
      this.joined.add(login);
      sent++;
    }
    if (sent > 0) {
      this.lastPumpAt = now;
      log(`twitch join: +${sent} (${this.joined.size}/${this.desired.size})`);
    }
  }

  private checkLiveness(): void {
    if (this.closing || !this.socket || !this.ready) return;
    const idle = Date.now() - this.lastActivity;
    if (idle > IRC_IDLE_RECONNECT_MS) {
      log(`twitch IRC idle ${Math.round(idle / 1000)}s — forcing reconnect`);
      this.socket.destroy();
    } else if (idle > IRC_IDLE_PING_MS) {
      this.send('PING :chat-collector');
    }
  }

  private send(line: string): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${line}\r\n`);
    }
  }
}

// ── Kick: one Pusher WebSocket ────────────────────────────────────────────

class KickPusher {
  private ws: WebSocket | null = null;
  private open = false;
  private closing = false;
  private desired = new Set<number>();     // chatroom ids we should be in
  private subscribed = new Set<number>();  // subscriptions sent on the current socket
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();

  constructor(
    private readonly appKey: string,
    private readonly onChat: (chatroomId: number, sender: string) => void,
  ) {}

  start(): void {
    this.connect();
    this.livenessTimer = setInterval(() => {
      try {
        this.checkLiveness();
      } catch {
        /* never throw out of a timer */
      }
    }, 30_000);
  }

  stop(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    try {
      this.ws?.terminate();
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  stats(): { subscribed: number; desired: number; connected: boolean } {
    return { subscribed: this.subscribed.size, desired: this.desired.size, connected: this.open };
  }

  /** Sync subscriptions to `chatroomIds`: subscribe new, unsubscribe removed. */
  setDesired(chatroomIds: Set<number>): void {
    for (const id of chatroomIds) {
      if (!this.desired.has(id)) {
        this.desired.add(id);
        this.subscribe(id);
      }
    }
    for (const id of [...this.desired]) {
      if (!chatroomIds.has(id)) {
        this.desired.delete(id);
        this.unsubscribe(id);
      }
    }
  }

  private connect(): void {
    if (this.closing) return;
    const url = `wss://ws-us2.pusher.com/app/${this.appKey}?protocol=7&client=js&version=8.4.0`;
    const ws = new WebSocket(url, {
      headers: { Origin: 'https://kick.com', 'User-Agent': BROWSER_UA },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.open = true;
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.lastActivity = Date.now();
      this.subscribed.clear();
      log(`kick pusher connected — subscribing ${this.desired.size} chatroom(s)`);
      for (const id of this.desired) this.subscribe(id);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.lastActivity = Date.now();
      const frame = parsePusherFrame(data.toString());
      if (!frame) return;
      if (frame.event === 'pusher:ping') {
        this.sendFrame({ event: 'pusher:pong', data: {} });
        return;
      }
      const chat = extractKickChat(frame);
      if (chat) this.onChat(chat.chatroomId, chat.sender);
      // pusher:connection_established, subscription acks, reactions, etc.
      // are irrelevant here — ignored.
    });

    ws.on('error', (err: Error) => {
      log(`kick pusher socket error: ${err.message}`);
      // 'close' follows and handles the reconnect.
    });

    ws.on('close', () => {
      if (this.closing) return;
      this.open = false;
      this.ws = null;
      this.subscribed.clear();
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
      log(`kick pusher disconnected — reconnecting in ${Math.round(delay / 1000)}s`);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private subscribe(id: number): void {
    if (!this.open || this.subscribed.has(id)) return;
    this.sendFrame({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${id}.v2` },
    });
    this.subscribed.add(id);
  }

  private unsubscribe(id: number): void {
    if (this.open && this.subscribed.has(id)) {
      this.sendFrame({ event: 'pusher:unsubscribe', data: { channel: `chatrooms.${id}.v2` } });
    }
    this.subscribed.delete(id);
  }

  private checkLiveness(): void {
    if (this.closing || !this.ws || !this.open) return;
    const idle = Date.now() - this.lastActivity;
    if (idle > PUSHER_IDLE_RECONNECT_MS) {
      log(`kick pusher idle ${Math.round(idle / 1000)}s — forcing reconnect`);
      this.ws.terminate();
    } else if (idle > PUSHER_IDLE_PING_MS) {
      this.sendFrame({ event: 'pusher:ping', data: {} });
    }
  }

  private sendFrame(frame: { event: string; data: unknown }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}

// ── Routing indexes + manager instances ───────────────────────────────────

const twitchIndex = new Map<string, string>(); // twitch login → channel_id
const kickIndex = new Map<number, string>();   // kick chatroom id → channel_id

const twitchIrc = new TwitchIrc((login, nick) => {
  const channelId = twitchIndex.get(login);
  if (channelId) recordMessage(channelId, nick);
});

const kickPusher = new KickPusher(KICK_PUSHER_KEY, (chatroomId, sender) => {
  const channelId = kickIndex.get(chatroomId);
  if (channelId) recordMessage(channelId, sender);
});

// ── Kick chatroom-id resolution (one-time per channel, cached in DB) ──────

const kickSkippedSlugs = new Set<string>(); // 403/404/malformed — skip this session
let kick403Logged = false;

async function resolveKickChatroomId(slug: string): Promise<number | null> {
  try {
    const { data } = await axios.get<{ chatroom?: { id?: number } }>(
      `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
      {
        timeout: 10_000,
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: `https://kick.com/${slug}`,
        },
      },
    );
    const id = data?.chatroom?.id;
    if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) {
      log(`kick chatroom lookup for "${slug}": no chatroom.id in response — skipping this session`);
      kickSkippedSlugs.add(slug);
      return null;
    }
    // Cache so this is a one-time lookup per channel. Merge into metadata
    // (never overwrite the whole jsonb); covers duplicate channel rows that
    // share the same slug across series.
    await db.raw(
      `UPDATE channels
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('kick_chatroom_id', ?::int)
        WHERE platform = 'kick' AND LOWER(channel_identifier) = ?`,
      [id, slug],
    );
    return id;
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 403) {
      kickSkippedSlugs.add(slug);
      if (!kick403Logged) {
        kick403Logged = true;
        log(
          `kick chatroom lookup got 403 (likely datacenter block) — affected channels are skipped for this session (first: "${slug}")`,
        );
      }
      return null;
    }
    if (status === 404) {
      log(`kick chatroom lookup for "${slug}": 404 — skipping this session`);
      kickSkippedSlugs.add(slug);
      return null;
    }
    log(`kick chatroom lookup for "${slug}" failed (${status ?? errMsg(err)}) — will retry next cycle`);
    return null;
  }
}

// ── Channel selection loop ────────────────────────────────────────────────

interface TrackedChannel {
  channelId: string;
  platform: 'twitch' | 'kick';
  identifier: string;       // lowercased login / slug
  chatroomId: number | null; // kick only
  lastSelectedAt: number;
}

// key = `${platform}:${identifier}`
const tracked = new Map<string, TrackedChannel>();

interface SelectionRow {
  channel_id: string;
  ccv: number;
  platform: string;
  identifier: string;
  kick_chatroom_id: string | null;
  tracker_slug: string;
  guaranteed: boolean;
}

// Latest snapshot per (tracker, channel) across all ACTIVE game trackers
// within the live window (snapshot rows are only written for live streams,
// so "has a row in the window" == "seen live"), CCV floor applied, then:
//   1. rank each tracker's channels by CCV — ranks ≤ CHAT_TRACKER_QUOTA are
//      that tracker's guaranteed slots (a tracker with fewer live channels
//      than the quota just gets all of them);
//   2. collapse to one row per channel (a channel live in several trackers
//      keeps its best rank — guaranteed anywhere == guaranteed);
//   3. guaranteed rows first so LIMIT can't cut them, remainder filled
//      globally by CCV up to CHAT_MAX_CHANNELS.
// Bindings: [CHAT_MIN_CCV, CHAT_TRACKER_QUOTA, CHAT_TRACKER_QUOTA, CHAT_MAX_CHANNELS]
const SELECTION_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (s.game_tracker_id, s.channel_id)
           s.game_tracker_id,
           t.slug                          AS tracker_slug,
           s.channel_id,
           s.concurrent_viewers            AS ccv,
           c.platform::text                AS platform,
           LOWER(c.channel_identifier)     AS identifier,
           c.metadata->>'kick_chatroom_id' AS kick_chatroom_id
    FROM game_tracker_snapshots s
    JOIN game_trackers t ON t.id = s.game_tracker_id AND t.status = 'active'
    JOIN channels c      ON c.id = s.channel_id
    WHERE s."timestamp" > NOW() - INTERVAL '${LIVE_WINDOW_MINUTES} minutes'
      AND c.platform IN ('twitch', 'kick')
    ORDER BY s.game_tracker_id, s.channel_id, s."timestamp" DESC
  ),
  ranked AS (
    SELECT *,
           ROW_NUMBER() OVER (
             PARTITION BY game_tracker_id ORDER BY ccv DESC, channel_id
           ) AS tracker_rank
    FROM latest
    WHERE ccv >= ?
  ),
  per_channel AS (
    SELECT DISTINCT ON (channel_id)
           channel_id, ccv, platform, identifier, kick_chatroom_id,
           tracker_slug, tracker_rank
    FROM ranked
    ORDER BY channel_id, tracker_rank ASC, ccv DESC
  )
  SELECT channel_id, ccv, platform, identifier, kick_chatroom_id,
         tracker_slug, (tracker_rank <= ?) AS guaranteed
  FROM per_channel
  ORDER BY (tracker_rank <= ?) DESC, ccv DESC
  LIMIT ?
`;

function parseChatroomId(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

let selectionRunning = false;

async function runSelection(): Promise<void> {
  if (selectionRunning) {
    log('selection: previous cycle still running — skipping');
    return;
  }
  selectionRunning = true;
  try {
    const res = await db.raw(SELECTION_SQL, [
      CHAT_MIN_CCV, CHAT_TRACKER_QUOTA, CHAT_TRACKER_QUOTA, CHAT_MAX_CHANNELS,
    ]);
    const rows = ((res as { rows?: SelectionRow[] }).rows ?? []) as SelectionRow[];
    const now = Date.now();

    // Merge into the tracked set. Rows arrive guaranteed-first, then
    // CCV-descending, so on duplicate (platform, identifier) pairs — same
    // streamer in two series — the best (guaranteed / highest-CCV) channel
    // row wins the key.
    const selectedKeys = new Set<string>();
    // Guaranteed quota coverage per tracker, for the selection log. A
    // channel live in several trackers is attributed to its best-rank one.
    const quotaBySlug = new Map<string, number>();
    let added = 0;
    for (const row of rows) {
      if (row.guaranteed) {
        quotaBySlug.set(row.tracker_slug, (quotaBySlug.get(row.tracker_slug) ?? 0) + 1);
      }
      const platform = row.platform === 'twitch' || row.platform === 'kick' ? row.platform : null;
      if (!platform) continue;
      const identifier = (row.identifier ?? '').trim();
      if (platform === 'twitch' && !TWITCH_LOGIN_RE.test(identifier)) continue;
      if (platform === 'kick' && !KICK_SLUG_RE.test(identifier)) continue;
      const key = `${platform}:${identifier}`;
      if (selectedKeys.has(key)) continue;
      selectedKeys.add(key);

      const cachedChatroomId = platform === 'kick' ? parseChatroomId(row.kick_chatroom_id) : null;
      const existing = tracked.get(key);
      if (existing) {
        existing.lastSelectedAt = now;
        existing.channelId = row.channel_id;
        if (existing.chatroomId === null && cachedChatroomId !== null) {
          existing.chatroomId = cachedChatroomId;
        }
      } else {
        tracked.set(key, {
          channelId: row.channel_id,
          platform,
          identifier,
          chatroomId: cachedChatroomId,
          lastSelectedAt: now,
        });
        added++;
      }
    }

    // Drop channels that fell out of the top N — after a 5-minute grace.
    let dropped = 0;
    let inGrace = 0;
    for (const [key, t] of tracked) {
      if (selectedKeys.has(key)) continue;
      if (now - t.lastSelectedAt > GRACE_MS) {
        tracked.delete(key);
        dropped++;
      } else {
        inGrace++;
      }
    }

    // Resolve missing Kick chatroom ids (bounded per cycle, politely spaced).
    let lookups = 0;
    for (const t of tracked.values()) {
      if (t.platform !== 'kick' || t.chatroomId !== null) continue;
      if (kickSkippedSlugs.has(t.identifier)) continue;
      if (lookups >= KICK_RESOLVE_MAX_PER_CYCLE) break;
      lookups++;
      const id = await resolveKickChatroomId(t.identifier);
      if (id !== null) t.chatroomId = id;
      await sleep(KICK_RESOLVE_DELAY_MS);
    }

    // Rebuild routing indexes and sync the connection managers.
    const twitchLogins = new Set<string>();
    const kickRooms = new Set<number>();
    twitchIndex.clear();
    kickIndex.clear();
    let kickPending = 0;
    for (const t of tracked.values()) {
      if (t.platform === 'twitch') {
        twitchLogins.add(t.identifier);
        twitchIndex.set(t.identifier, t.channelId);
      } else if (t.chatroomId !== null) {
        kickRooms.add(t.chatroomId);
        kickIndex.set(t.chatroomId, t.channelId);
      } else if (!kickSkippedSlugs.has(t.identifier)) {
        kickPending++;
      }
    }
    twitchIrc.setDesired(twitchLogins);
    kickPusher.setDesired(kickRooms);

    const quotaSummary = [...quotaBySlug.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([slug, n]) => `${slug} ${n}/${CHAT_TRACKER_QUOTA}`)
      .join(', ');
    log(
      `selection: ${twitchLogins.size} twitch / ${kickRooms.size} kick` +
        ` (+${added} new, -${dropped} dropped, ${inGrace} in grace` +
        (kickPending > 0 ? `, ${kickPending} kick awaiting chatroom id` : '') +
        (kickSkippedSlugs.size > 0 ? `, ${kickSkippedSlugs.size} kick skipped` : '') +
        `) — quota${quotaSummary ? ` ${quotaSummary}` : ' (none live)'}`,
    );
  } finally {
    selectionRunning = false;
  }
}

async function runSelectionSafe(): Promise<void> {
  try {
    await runSelection();
  } catch (err) {
    log(`selection ERROR: ${errMsg(err)}`);
  }
}

// ── Rollup flusher ────────────────────────────────────────────────────────

interface RollupRow {
  channel_id: string;
  minute: string; // ISO timestamp of the minute start
  messages: number;
  chatters: number;
}

let pendingRetry: RollupRow[] = []; // rows from a failed flush, retried next time
let lifetimeMessages = 0;
let lifetimeRows = 0;

async function flushRollup(finalFlush = false): Promise<void> {
  // Collect completed minutes (everything before the current minute) plus any
  // rows a previous failed flush left behind. On shutdown, take the current
  // partial minute too — the additive upsert merges cleanly after restart.
  const cutoffMs = Math.floor(Date.now() / 60_000) * 60_000;
  const rows: RollupRow[] = pendingRetry;
  pendingRetry = [];

  for (const [channelId, perMinute] of buckets) {
    for (const [minuteMs, bucket] of perMinute) {
      if (!finalFlush && minuteMs >= cutoffMs) continue;
      rows.push({
        channel_id: channelId,
        minute: new Date(minuteMs).toISOString(),
        messages: bucket.messages,
        chatters: bucket.chatters.size,
      });
      perMinute.delete(minuteMs);
    }
    if (perMinute.size === 0) buckets.delete(channelId);
  }

  const tw = twitchIrc.stats();
  const kk = kickPusher.stats();
  const subs = `subscribed ${tw.joined}/${tw.desired} twitch / ${kk.subscribed}/${kk.desired} kick`;

  if (rows.length === 0) {
    log(`flushed 0 rows — ${subs}`);
    return;
  }

  // Merge duplicate (channel, minute) keys (possible when retry rows meet a
  // re-opened bucket after a clock step) — ON CONFLICT can't touch the same
  // row twice within one INSERT.
  const merged = new Map<string, RollupRow>();
  for (const r of rows) {
    const key = `${r.channel_id}|${r.minute}`;
    const existing = merged.get(key);
    if (existing) {
      existing.messages += r.messages;
      existing.chatters = Math.max(existing.chatters, r.chatters);
    } else {
      merged.set(key, { ...r });
    }
  }
  const toWrite = [...merged.values()];

  const valuesSql = toWrite.map(() => '(?::uuid, ?::timestamptz, ?::int, ?::int)').join(', ');
  const bindings: Array<string | number> = [];
  for (const r of toWrite) {
    bindings.push(r.channel_id, r.minute, r.messages, r.chatters);
  }

  try {
    await db.raw(
      `INSERT INTO chat_minute_rollup (channel_id, minute, messages, chatters)
       VALUES ${valuesSql}
       ON CONFLICT (channel_id, minute) DO UPDATE
         SET messages = chat_minute_rollup.messages + EXCLUDED.messages,
             chatters = GREATEST(chat_minute_rollup.chatters, EXCLUDED.chatters)`,
      bindings,
    );
    const msgSum = toWrite.reduce((sum, r) => sum + r.messages, 0);
    const chatterSum = toWrite.reduce((sum, r) => sum + r.chatters, 0);
    lifetimeMessages += msgSum;
    lifetimeRows += toWrite.length;
    log(
      `flushed ${toWrite.length} rows (${msgSum.toLocaleString()} msgs, ${chatterSum.toLocaleString()} chatters) — ` +
        `${subs} — lifetime ${lifetimeRows.toLocaleString()} rows / ${lifetimeMessages.toLocaleString()} msgs`,
    );
  } catch (err) {
    // Keep the rows (as plain counts — sets are already reduced) and retry on
    // the next flush; the additive upsert makes a retry safe as long as the
    // failed statement didn't commit. Cap to bound memory during outages.
    pendingRetry = toWrite.length > PENDING_RETRY_MAX ? toWrite.slice(toWrite.length - PENDING_RETRY_MAX) : toWrite;
    log(`flush FAILED (${toWrite.length} rows queued for retry): ${errMsg(err)}`);
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Self-rescheduling so every flush stays aligned just after the minute boundary. */
function scheduleNextFlush(): void {
  if (shuttingDown) return;
  const now = Date.now();
  const nextBoundary = Math.floor(now / 60_000) * 60_000 + 60_000;
  flushTimer = setTimeout(async () => {
    try {
      await flushRollup();
    } catch (err) {
      log(`flush loop error: ${errMsg(err)}`);
    }
    scheduleNextFlush();
  }, nextBoundary - now + FLUSH_LAG_MS);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────

let selectionTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — final flush + shutdown`);

  if (flushTimer) clearTimeout(flushTimer);
  if (selectionTimer) clearInterval(selectionTimer);
  twitchIrc.stop();
  kickPusher.stop();

  try {
    await flushRollup(true); // include the current partial minute
  } catch (err) {
    log(`final flush error: ${errMsg(err)}`);
  }
  try {
    await db.destroy();
  } catch {
    /* noop */
  }
  log('shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${errMsg(reason)}`);
});

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set. Add it to .env or export it.');
    process.exit(1);
  }

  log(
    `chat collector starting — top ${CHAT_MAX_CHANNELS} live channels (twitch|kick), ` +
      `ccv floor ${CHAT_MIN_CCV}, ${CHAT_TRACKER_QUOTA} guaranteed slots/tracker, ` +
      `selection every ${SELECTION_INTERVAL_MS / 1000}s, flush every 60s` +
      (process.env.KICK_PUSHER_KEY ? ', KICK_PUSHER_KEY overridden from env' : ''),
  );

  // Fail fast if the DB is unreachable/misconfigured.
  await db.raw('SELECT 1');

  twitchIrc.start();
  kickPusher.start();

  await runSelectionSafe();
  selectionTimer = setInterval(() => void runSelectionSafe(), SELECTION_INTERVAL_MS);

  scheduleNextFlush();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
