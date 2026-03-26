import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import * as ChannelModel from '../../models/channel';
import * as ChannelBroadcastDayModel from '../../models/channel-broadcast-day';
import * as BroadcastDayModel from '../../models/broadcast-day';
import * as TournamentSeriesModel from '../../models/tournament-series';
import { SteamAdapter } from '../../adapters/steam';
import db from '../../utils/db';
import logger from '../../utils/logger';
import { requireRole } from '../middleware/auth';

const router = Router();

// ── Platform URL → username extraction ────────────────────────────────────

const PLATFORM_URL_PATTERNS: Record<string, RegExp> = {
  twitch: /(?:twitch\.tv)\/([a-zA-Z0-9_]+)\/?$/,
  kick: /(?:kick\.com)\/([a-zA-Z0-9_]+)\/?$/,
  tiktok: /(?:tiktok\.com\/@?)([a-zA-Z0-9_.]+)\/?$/,
  steam: /steamcommunity\.com\/(?:profiles\/(\d+)|id\/([a-zA-Z0-9_-]+))/,
};

/**
 * Strips platform URLs to just the username/identifier.
 * e.g. "https://www.twitch.tv/batulins" → "batulins"
 */
function extractIdentifierFromUrl(platform: string, identifier: string): string {
  const trimmed = identifier.trim();
  const pattern = PLATFORM_URL_PATTERNS[platform];
  if (!pattern) return trimmed;
  const match = trimmed.match(pattern);
  if (!match) return trimmed;
  // Steam URLs have two capture groups (profiles/ID or id/vanity)
  if (platform === 'steam') return match[1] || match[2] || trimmed;
  return match[1] || trimmed;
}

// ── YouTube identifier resolution ────────────────────────────────────────

const YT_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;
const YT_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const YT_VIDEO_URL_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const YT_VIDEO_PREFIX = 'yt-video:';

/**
 * Detects if the identifier is a YouTube video URL or video ID.
 * Returns `yt-video:VIDEO_ID` if so, otherwise null.
 */
function detectYouTubeVideoId(identifier: string): string | null {
  // Direct video URL: youtube.com/watch?v=... or youtu.be/...
  const urlMatch = identifier.match(YT_VIDEO_URL_RE);
  if (urlMatch) return `${YT_VIDEO_PREFIX}${urlMatch[1]}`;

  // Already prefixed
  if (identifier.startsWith(YT_VIDEO_PREFIX)) return identifier;

  return null;
}

/**
 * Resolves a YouTube handle/username/URL to a channel ID (UC...).
 * For video URLs, returns yt-video:VIDEO_ID format.
 * Returns the original identifier if it's already a channel ID or resolution fails.
 */
async function resolveYouTubeIdentifier(identifier: string): Promise<string> {
  // Check if it's a video URL/ID first
  const videoId = detectYouTubeVideoId(identifier);
  if (videoId) return videoId;

  // Already a channel ID
  if (YT_CHANNEL_ID_RE.test(identifier)) return identifier;

  // Build URL
  let url: string;
  if (identifier.startsWith('http')) {
    url = identifier;
  } else if (identifier.startsWith('@')) {
    url = `https://www.youtube.com/${identifier}`;
  } else {
    url = `https://www.youtube.com/@${identifier}`;
  }

  try {
    const { data: html } = await axios.get<string>(url, {
      timeout: 8000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: (s) => s < 500,
    });

    if (typeof html !== 'string') return identifier;

    const match =
      html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/) ??
      html.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/);

    if (match) {
      logger.info(`YouTube: resolved "${identifier}" → ${match[1]}`);
      return match[1];
    }
  } catch (err) {
    logger.warn(`YouTube: failed to resolve "${identifier}"`, { error: (err as Error).message });
  }

  return identifier;
}

// ── Steam identifier resolution ─────────────────────────────────────────

const STEAM64_ID_RE = /^7656119\d{10}$/;
let steamAdapter: SteamAdapter | null = null;

/**
 * Resolves a Steam identifier (vanity name, profile URL, or Steam64 ID)
 * to a Steam64 ID via the Steam API.
 */
async function resolveSteamIdentifier(identifier: string): Promise<string> {
  // Already a Steam64 ID
  if (STEAM64_ID_RE.test(identifier)) return identifier;

  try {
    if (!steamAdapter) steamAdapter = new SteamAdapter();
    const resolved = await steamAdapter.resolveToSteam64(identifier);
    if (resolved) {
      logger.info(`Steam: resolved "${identifier}" → ${resolved}`);
      return resolved;
    }
  } catch (err) {
    logger.warn(`Steam: failed to resolve "${identifier}"`, { error: (err as Error).message });
  }

  return identifier;
}

// ── Helper: attach broadcast_day_ids to channel objects ──────────────────

async function attachBroadcastDayIds<T extends { id: string }>(
  channels: T[],
): Promise<(T & { broadcast_day_ids: string[] })[]> {
  if (channels.length === 0) return [];
  const channelIds = channels.map((ch) => ch.id);
  const assignments = await ChannelBroadcastDayModel.findByChannelIds(channelIds);

  // Build map: channelId → dayIds[]
  const map = new Map<string, string[]>();
  for (const a of assignments) {
    const list = map.get(a.channel_id) ?? [];
    list.push(a.broadcast_day_id);
    map.set(a.channel_id, list);
  }

  return channels.map((ch) => ({
    ...ch,
    broadcast_day_ids: map.get(ch.id) ?? [],
  }));
}

// ── Helper: validate broadcast_day_ids belong to the same series ─────────

async function validateBroadcastDayIds(
  broadcastDayIds: string[],
  seriesId: string,
): Promise<string | null> {
  if (broadcastDayIds.length === 0) return null;
  const days = await BroadcastDayModel.findAll({ series_id: seriesId });
  const validIds = new Set(days.map((d) => d.id));
  const invalid = broadcastDayIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    return `Invalid broadcast_day_ids for this series: ${invalid.join(', ')}`;
  }
  return null;
}

// GET /api/series/:seriesId/channels — List channels (filterable)
router.get('/:seriesId/channels', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await TournamentSeriesModel.findById(req.params.seriesId as string);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }

    const filters: Partial<Pick<ChannelModel.Channel, 'series_id' | 'platform' | 'is_active' | 'tier'>> = {
      series_id: req.params.seriesId as string,
    };

    const { platform, tier, source, is_active } = req.query;
    if (platform && ['twitch', 'youtube', 'kick', 'tiktok', 'steam', 'trovo', 'chzzk', 'soop'].includes(platform as string)) {
      filters.platform = platform as ChannelModel.Platform;
    }
    if (tier && ['official', 'partner', 'community', 'player', 'watch_party'].includes(tier as string)) {
      filters.tier = tier as ChannelModel.ChannelTier;
    }
    if (is_active !== undefined) {
      filters.is_active = is_active === 'true';
    }

    let channels = await ChannelModel.findAll(filters);

    // Filter by source in-memory (not in the typed filter interface)
    if (source && ['manual', 'auto_discovered'].includes(source as string)) {
      channels = channels.filter((ch) => ch.source === source);
    } else {
      // Show all channels. The frontend handles active/inactive filtering via tabs.
      // Discovery feed handles unapproved new discoveries separately.
    }

    // Attach broadcast_day_ids to each channel
    const enriched = await attachBroadcastDayIds(channels);
    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

// POST /api/series/:seriesId/channels — Add a channel (editor+)
router.post('/:seriesId/channels', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { platform, channel_identifier, display_name, broadcast_day_ids } = req.body;
    if (!platform || !['twitch', 'youtube', 'kick', 'tiktok', 'steam', 'trovo', 'chzzk', 'soop'].includes(platform)) {
      res.status(400).json({ error: 'platform must be one of: twitch, youtube, kick, tiktok, steam, trovo, chzzk, soop' });
      return;
    }
    if (!channel_identifier || typeof channel_identifier !== 'string') {
      res.status(400).json({ error: 'channel_identifier is required' });
      return;
    }
    if (!display_name || typeof display_name !== 'string') {
      res.status(400).json({ error: 'display_name is required' });
      return;
    }

    const seriesId = req.params.seriesId as string;
    const series = await TournamentSeriesModel.findById(seriesId);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }

    // Validate broadcast_day_ids if provided
    const dayIds: string[] = Array.isArray(broadcast_day_ids) ? broadcast_day_ids : [];
    if (dayIds.length > 0) {
      const validationError = await validateBroadcastDayIds(dayIds, seriesId);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
    }

    // Strip platform URLs to just the username and resolve YouTube/Steam identifiers
    let resolvedIdentifier = extractIdentifierFromUrl(platform, channel_identifier);
    if (platform === 'youtube' && !YT_CHANNEL_ID_RE.test(resolvedIdentifier)) {
      resolvedIdentifier = await resolveYouTubeIdentifier(resolvedIdentifier);
    }
    if (platform === 'steam' && !STEAM64_ID_RE.test(resolvedIdentifier)) {
      resolvedIdentifier = await resolveSteamIdentifier(resolvedIdentifier);
    }

    // Strip broadcast_day_ids from body before inserting (it's not a column on channels)
    const { broadcast_day_ids: _dayIds, ...channelBody } = req.body;
    // Normalize language to base code (e.g. en-US → en)
    if (channelBody.language && typeof channelBody.language === 'string') {
      channelBody.language = channelBody.language.split('-')[0].toLowerCase();
    }
    let channel;
    try {
      channel = await ChannelModel.create({
        ...channelBody,
        channel_identifier: resolvedIdentifier,
        series_id: seriesId,
        source: channelBody.source || 'manual',
        is_active: channelBody.is_active !== undefined ? channelBody.is_active : true,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('unique') || msg.includes('duplicate')) {
        res.status(409).json({ error: `Channel ${resolvedIdentifier} on ${platform} already exists in this series` });
        return;
      }
      throw err;
    }

    // Assign to specific broadcast days if provided
    if (dayIds.length > 0) {
      await ChannelBroadcastDayModel.replaceForChannel(channel.id, dayIds);
    }

    res.status(201).json({ ...channel, broadcast_day_ids: dayIds });
  } catch (err) {
    next(err);
  }
});

// POST /api/series/:seriesId/channels/bulk — Add multiple channels (editor+)
router.post('/:seriesId/channels/bulk', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channels, broadcast_day_ids } = req.body;
    if (!Array.isArray(channels) || channels.length === 0) {
      res.status(400).json({ error: 'channels must be a non-empty array' });
      return;
    }

    const seriesId = req.params.seriesId as string;
    const series = await TournamentSeriesModel.findById(seriesId);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }

    // Validate shared broadcast_day_ids if provided
    const dayIds: string[] = Array.isArray(broadcast_day_ids) ? broadcast_day_ids : [];
    if (dayIds.length > 0) {
      const validationError = await validateBroadcastDayIds(dayIds, seriesId);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
    }

    const results: ChannelModel.Channel[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      if (!ch.platform || !ch.channel_identifier || !ch.display_name) {
        errors.push({ index: i, error: 'platform, channel_identifier, and display_name are required' });
        continue;
      }
      try {
        let resolvedId = extractIdentifierFromUrl(ch.platform, ch.channel_identifier);
        if (ch.platform === 'youtube' && !YT_CHANNEL_ID_RE.test(resolvedId)) {
          resolvedId = await resolveYouTubeIdentifier(resolvedId);
        }
        if (ch.platform === 'steam' && !STEAM64_ID_RE.test(resolvedId)) {
          resolvedId = await resolveSteamIdentifier(resolvedId);
        }
        // Strip broadcast_day_ids from individual channel objects (not a DB column)
        const { broadcast_day_ids: _bdi, ...chBody } = ch;
        // Normalize language to base code (e.g. en-US → en)
        if (chBody.language && typeof chBody.language === 'string') {
          chBody.language = chBody.language.split('-')[0].toLowerCase();
        }
        const created = await ChannelModel.create({
          ...chBody,
          channel_identifier: resolvedId,
          series_id: seriesId,
          source: chBody.source || 'manual',
          is_active: chBody.is_active !== undefined ? chBody.is_active : true,
        });

        // Assign to specific broadcast days if provided
        if (dayIds.length > 0) {
          await ChannelBroadcastDayModel.replaceForChannel(created.id, dayIds);
        }

        results.push(created);
      } catch (err) {
        errors.push({ index: i, error: (err as Error).message });
      }
    }

    res.status(201).json({ created: results, errors });
  } catch (err) {
    next(err);
  }
});

// PUT /api/channels/:id — Update a channel (editor+)
router.put('/channels/:id', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await ChannelModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    // Normalize language to base code (e.g. en-US → en)
    if (req.body.language && typeof req.body.language === 'string') {
      req.body.language = req.body.language.split('-')[0].toLowerCase();
    }
    const updated = await ChannelModel.update(req.params.id as string, req.body);

    // Retroactively update snapshot language if changed
    if (req.body.language !== undefined && req.body.language !== existing.language) {
      const count = await db('viewership_snapshots')
        .where('channel_id', req.params.id as string)
        .update({ language: req.body.language || null });
      logger.info(`Retroactively updated language on ${count} snapshots for channel ${req.params.id} (${existing.language} → ${req.body.language})`);
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// PUT /api/channels/:id/days — Update broadcast day assignments (editor+)
router.put('/channels/:id/days', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channelId = req.params.id as string;
    const existing = await ChannelModel.findById(channelId);
    if (!existing) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const { broadcast_day_ids } = req.body;
    const dayIds: string[] = Array.isArray(broadcast_day_ids) ? broadcast_day_ids : [];

    // Validate that all day IDs belong to the channel's series
    if (dayIds.length > 0) {
      const validationError = await validateBroadcastDayIds(dayIds, existing.series_id);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
    }

    await ChannelBroadcastDayModel.replaceForChannel(channelId, dayIds);
    res.json({ broadcast_day_ids: dayIds });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/channels/:id — Remove a channel and all its data (admin only)
router.delete('/channels/:id', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await ChannelModel.remove(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// PUT /api/channels/:id/active — Toggle active status (editor+)
router.put('/channels/:id/active', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      res.status(400).json({ error: 'is_active must be a boolean' });
      return;
    }
    const existing = await ChannelModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    // When re-enabling a channel: clear auto_paused metadata and assign current live broadcast day
    if (is_active && !existing.is_active) {
      const meta = existing.metadata as Record<string, unknown>;
      if (meta?.auto_paused) {
        await db('channels')
          .where('id', req.params.id as string)
          .update({
            is_active: true,
            metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'auto_paused' - 'auto_paused_at'"),
          });
      } else {
        await ChannelModel.update(req.params.id as string, { is_active: true });
      }

      // Add the current live broadcast day(s) — preserves existing day assignments
      const liveDays = await db('broadcast_days')
        .where('series_id', existing.series_id)
        .where('status', 'live')
        .select('id');
      if (liveDays.length > 0) {
        const rows = liveDays.map((d: { id: string }) => ({
          channel_id: req.params.id as string,
          broadcast_day_id: d.id,
        }));
        await db('channel_broadcast_days').insert(rows).onConflict(['channel_id', 'broadcast_day_id']).ignore();
      }

      const updated = await ChannelModel.findById(req.params.id as string);
      res.json(updated);
      return;
    }
    const updated = await ChannelModel.update(req.params.id as string, { is_active });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/channels/:id/promote — Promote auto-discovered channel to manual (editor+)
router.patch('/channels/:id/promote', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await ChannelModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    if (existing.source !== 'auto_discovered') {
      res.status(400).json({ error: 'Channel is already manual' });
      return;
    }

    await db('channels')
      .where('id', req.params.id as string)
      .update({
        source: 'manual',
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'auto_paused' - 'auto_paused_at'"),
      });

    // Remove day assignments so it becomes "All Days"
    await db('channel_broadcast_days').where('channel_id', req.params.id as string).del();

    const updated = await ChannelModel.findById(req.params.id as string);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
