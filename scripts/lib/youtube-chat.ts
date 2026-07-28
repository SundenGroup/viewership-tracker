/**
 * YouTube live-chat reader (InnerTube).
 *
 * Plan: docs/plans/2026-07-28-youtube-in-discover.md
 *
 * Why not the official API: `liveChatMessages.list` must be polled every few
 * seconds per stream, which costs ~17,000 quota units per day for a SINGLE
 * stream. Unusable. The endpoint YouTube's own chat iframe uses costs no
 * quota and needs no key, so that's what we read — the same trade we make
 * for the /live scrape.
 *
 * Shape differs from our other collectors: Twitch IRC multiplexes hundreds
 * of channels over one socket and Kick Pusher does the same over one WS,
 * but YouTube needs ONE polling loop PER STREAM. The pool therefore caps
 * concurrency and honours the server-provided `timeoutMs` between polls
 * (~10s observed) instead of hammering.
 *
 * Fail-soft throughout: an unofficial surface that changes shape must
 * degrade to "no chat for this stream", never crash the collector.
 */
import axios from 'axios';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_POLL_MS = 10_000;
const MIN_POLL_MS = 4_000;
const MAX_POLL_MS = 30_000;
/** Consecutive failures before a stream is parked (chat off/ended/changed). */
const MAX_FAILURES = 4;

const http = axios.create({
  timeout: 15_000,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
  },
  validateStatus: (s) => s < 500,
});

interface ChatSession {
  videoId: string;
  channelId: string;
  apiKey: string;
  clientVersion: string;
  continuation: string;
  failures: number;
  stopped: boolean;
}

export interface YouTubeChatPoolOptions {
  /** Called once per chat message: (our channel_id, stable author id). */
  onMessage: (channelId: string, authorId: string) => void;
  log: (msg: string) => void;
  /** Max streams polled concurrently. */
  maxStreams?: number;
}

/**
 * Bootstrap: the popout chat page carries the InnerTube key, the client
 * version and the first continuation token. Returns null when the stream
 * has no live chat (disabled, ended, members-only).
 */
async function openSession(videoId: string, channelId: string): Promise<ChatSession | null> {
  const { data: html, status } = await http.get<string>(
    `https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(videoId)}`,
    { responseType: 'text' },
  );
  if (status !== 200 || typeof html !== 'string') return null;

  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  const continuation = html.match(/"continuation":"([^"]{40,})"/)?.[1];
  if (!apiKey || !clientVersion || !continuation) return null;

  return { videoId, channelId, apiKey, clientVersion, continuation, failures: 0, stopped: false };
}

/** One poll: returns the next wait in ms, or null when the session is done. */
async function pollOnce(
  session: ChatSession,
  onMessage: (channelId: string, authorId: string) => void,
): Promise<number | null> {
  const { data, status } = await http.post<Record<string, unknown>>(
    `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${session.apiKey}`,
    {
      context: {
        client: { clientName: 'WEB', clientVersion: session.clientVersion, hl: 'en', gl: 'US' },
      },
      continuation: session.continuation,
    },
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (status !== 200 || !data) return null;

  const cont = (data as {
    continuationContents?: { liveChatContinuation?: Record<string, unknown> };
  }).continuationContents?.liveChatContinuation;
  if (!cont) return null; // chat ended

  for (const action of (cont.actions as Array<Record<string, unknown>>) ?? []) {
    const item = (action.addChatItemAction as { item?: Record<string, unknown> } | undefined)?.item;
    if (!item) continue;
    // Plain messages + Super Chats both count as chat activity.
    const renderer =
      (item.liveChatTextMessageRenderer as Record<string, unknown> | undefined) ??
      (item.liveChatPaidMessageRenderer as Record<string, unknown> | undefined);
    if (!renderer) continue;
    // Stable per-user id — survives display-name changes, which is what
    // makes the unique-chatter count meaningful.
    const authorId =
      (renderer.authorExternalChannelId as string | undefined) ??
      ((renderer.authorName as { simpleText?: string } | undefined)?.simpleText ?? null);
    if (!authorId) continue;
    onMessage(session.channelId, authorId);
  }

  const next = ((cont.continuations as Array<Record<string, unknown>>) ?? [])[0] ?? {};
  const data2 =
    (next.invalidationContinuationData as Record<string, unknown> | undefined) ??
    (next.timedContinuationData as Record<string, unknown> | undefined) ??
    (next.reloadContinuationData as Record<string, unknown> | undefined);
  const token = data2?.continuation as string | undefined;
  if (!token) return null;
  session.continuation = token;

  const timeout = Number(data2?.timeoutMs ?? DEFAULT_POLL_MS);
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Number.isFinite(timeout) ? timeout : DEFAULT_POLL_MS));
}

export class YouTubeChatPool {
  private readonly opts: Required<YouTubeChatPoolOptions>;
  /** videoId → running loop state. */
  private readonly sessions = new Map<string, ChatSession>();
  private readonly desired = new Map<string, string>(); // videoId → channelId

  constructor(opts: YouTubeChatPoolOptions) {
    this.opts = { maxStreams: 120, ...opts } as Required<YouTubeChatPoolOptions>;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /** Reconcile to the desired set — start new loops, stop departed ones. */
  setDesired(next: Map<string, string>): void {
    this.desired.clear();
    let n = 0;
    for (const [videoId, channelId] of next) {
      if (n >= this.opts.maxStreams) break;
      this.desired.set(videoId, channelId);
      n++;
    }

    for (const [videoId, session] of this.sessions) {
      if (!this.desired.has(videoId)) {
        session.stopped = true;
        this.sessions.delete(videoId);
      }
    }
    for (const [videoId, channelId] of this.desired) {
      if (!this.sessions.has(videoId)) void this.startLoop(videoId, channelId);
    }
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.stopped = true;
    this.sessions.clear();
    this.desired.clear();
  }

  private async startLoop(videoId: string, channelId: string): Promise<void> {
    let session: ChatSession | null = null;
    try {
      session = await openSession(videoId, channelId);
    } catch {
      session = null;
    }
    if (!session) {
      this.opts.log(`youtube chat: no live chat for ${videoId} (disabled or ended)`);
      return;
    }
    // The desired set may have changed while we were bootstrapping.
    if (!this.desired.has(videoId)) return;
    this.sessions.set(videoId, session);

    while (!session.stopped && this.desired.has(videoId)) {
      let wait: number | null = null;
      try {
        wait = await pollOnce(session, this.opts.onMessage);
        session.failures = 0;
      } catch {
        session.failures++;
        wait = DEFAULT_POLL_MS * Math.min(4, session.failures); // linear backoff
      }
      if (wait === null || session.failures >= MAX_FAILURES) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    this.sessions.delete(videoId);
  }
}
