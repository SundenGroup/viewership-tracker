import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import * as ChannelModel from '../../models/channel';
import * as TournamentSeriesModel from '../../models/tournament-series';
import logger from '../../utils/logger';
import { requireRole } from '../middleware/auth';

const router = Router();

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
    if (platform && ['twitch', 'youtube', 'kick', 'tiktok'].includes(platform as string)) {
      filters.platform = platform as ChannelModel.Platform;
    }
    if (tier && ['primary', 'secondary', 'community', 'watch_party'].includes(tier as string)) {
      filters.tier = tier as ChannelModel.ChannelTier;
    }
    if (is_active !== undefined) {
      filters.is_active = is_active === 'true';
    }

    let channels = await ChannelModel.findAll(filters);

    // Filter by source in-memory (not in the typed filter interface)
    if (source && ['manual', 'auto_discovered'].includes(source as string)) {
      channels = channels.filter((ch) => ch.source === source);
    }

    res.json(channels);
  } catch (err) {
    next(err);
  }
});

// POST /api/series/:seriesId/channels — Add a channel (editor+)
router.post('/:seriesId/channels', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { platform, channel_identifier, display_name } = req.body;
    if (!platform || !['twitch', 'youtube', 'kick', 'tiktok'].includes(platform)) {
      res.status(400).json({ error: 'platform must be one of: twitch, youtube, kick, tiktok' });
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

    const series = await TournamentSeriesModel.findById(req.params.seriesId as string);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }

    // Auto-resolve YouTube handles/usernames to channel IDs
    let resolvedIdentifier = channel_identifier;
    if (platform === 'youtube' && !YT_CHANNEL_ID_RE.test(channel_identifier)) {
      resolvedIdentifier = await resolveYouTubeIdentifier(channel_identifier);
    }

    const channel = await ChannelModel.create({
      ...req.body,
      channel_identifier: resolvedIdentifier,
      series_id: req.params.seriesId as string,
      source: req.body.source || 'manual',
      is_active: req.body.is_active !== undefined ? req.body.is_active : true,
    });
    res.status(201).json(channel);
  } catch (err) {
    next(err);
  }
});

// POST /api/series/:seriesId/channels/bulk — Add multiple channels (editor+)
router.post('/:seriesId/channels/bulk', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channels } = req.body;
    if (!Array.isArray(channels) || channels.length === 0) {
      res.status(400).json({ error: 'channels must be a non-empty array' });
      return;
    }

    const series = await TournamentSeriesModel.findById(req.params.seriesId as string);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
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
        const created = await ChannelModel.create({
          ...ch,
          series_id: req.params.seriesId as string,
          source: ch.source || 'manual',
          is_active: ch.is_active !== undefined ? ch.is_active : true,
        });
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
    const updated = await ChannelModel.update(req.params.id as string, req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/channels/:id — Remove a channel (editor+)
router.delete('/channels/:id', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
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

// PUT /api/channels/:id/active — Toggle active status
router.put('/channels/:id/active', async (req: Request, res: Response, next: NextFunction) => {
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
    const updated = await ChannelModel.update(req.params.id as string, { is_active });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
