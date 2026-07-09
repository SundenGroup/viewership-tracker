/**
 * Pure parsing helpers for the chat collector (scripts/chat-collector.ts).
 *
 * Dependency-free and side-effect-free so the exact shipped parsing can be
 * exercised with a bare `npx tsx` snippet without touching the network or DB.
 */

// ── Twitch IRC ────────────────────────────────────────────────────────────

/**
 * Matches a Twitch IRC PRIVMSG line:
 *   :nick!nick@nick.tmi.twitch.tv PRIVMSG #channel :message text
 *
 * Group 1 = sender nick, group 2 = channel login (without '#').
 * Tolerates an optional leading IRCv3 tags block (`@key=val;… `) even though
 * the collector doesn't request the tags capability — cheap future-proofing.
 */
export const PRIVMSG_RE = /^(?:@\S+ )?:([^!\s]+)!\S+ PRIVMSG #(\S+) :/;

export interface ParsedPrivmsg {
  channel: string; // lowercased login, no '#'
  nick: string;    // lowercased sender login
}

export function parsePrivmsg(line: string): ParsedPrivmsg | null {
  const m = PRIVMSG_RE.exec(line);
  if (!m) return null;
  return { channel: m[2].toLowerCase(), nick: m[1].toLowerCase() };
}

// ── Kick (Pusher protocol) ────────────────────────────────────────────────

/**
 * The Pusher event name Kick uses for chat messages. On the wire it appears
 * as "App\\Events\\ChatMessageEvent" inside the JSON frame; after JSON.parse
 * the event string contains single backslashes, which is what this literal
 * evaluates to.
 */
export const KICK_CHAT_EVENT = 'App\\Events\\ChatMessageEvent';

export interface PusherFrame {
  event: string;
  data?: unknown;    // usually a JSON *string* that needs a second parse
  channel?: unknown; // e.g. "chatrooms.123.v2"
}

/** Parses one raw Pusher websocket frame. Returns null for junk. */
export function parsePusherFrame(raw: string): PusherFrame | null {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object') return null;
  const rec = frame as { event?: unknown; data?: unknown; channel?: unknown };
  if (typeof rec.event !== 'string') return null;
  return { event: rec.event, data: rec.data, channel: rec.channel };
}

/** "chatrooms.123.v2" → 123 (null for anything else). */
export function chatroomIdFromPusherChannel(channel: unknown): number | null {
  if (typeof channel !== 'string') return null;
  const m = /^chatrooms\.(\d+)\.v2$/.exec(channel);
  return m ? Number(m[1]) : null;
}

export interface ParsedKickChat {
  chatroomId: number;
  sender: string; // stable per-sender key: numeric user id when present, else username
}

/**
 * Extracts a chat event from an already-parsed Pusher frame. Returns null
 * for non-chat frames (pings, subscription acks, other event types) and for
 * chat frames whose payload can't be attributed to a chatroom + sender.
 */
export function extractKickChat(frame: PusherFrame): ParsedKickChat | null {
  if (frame.event !== KICK_CHAT_EVENT) return null;

  let chatroomId = chatroomIdFromPusherChannel(frame.channel);
  let sender = '';
  try {
    const inner: unknown =
      typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
    if (!inner || typeof inner !== 'object') return null;
    const rec = inner as { chatroom_id?: unknown; sender?: unknown };
    if (chatroomId === null && typeof rec.chatroom_id === 'number') {
      chatroomId = rec.chatroom_id;
    }
    if (rec.sender && typeof rec.sender === 'object') {
      const s = rec.sender as { id?: unknown; username?: unknown };
      if (typeof s.id === 'number' || (typeof s.id === 'string' && s.id !== '')) {
        sender = String(s.id);
      } else if (typeof s.username === 'string' && s.username !== '') {
        sender = s.username.toLowerCase();
      }
    }
  } catch {
    return null;
  }

  if (chatroomId === null || !sender) return null;
  return { chatroomId, sender };
}

/** Convenience: raw frame string → chat event (used by the parse test). */
export function parseKickChatFrame(raw: string): ParsedKickChat | null {
  const frame = parsePusherFrame(raw);
  return frame ? extractKickChat(frame) : null;
}
