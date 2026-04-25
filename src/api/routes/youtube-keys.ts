/**
 * YouTube API key admin endpoints. All routes require admin role (mounted
 * behind `requireRole('admin')` in server.ts).
 *
 * Used by the redesign Settings → API Keys page to add / edit / soft-delete
 * keys without restarting the backend. The discovery key pool reads keys
 * from the DB on every search call so additions take effect immediately.
 */

import { Router, Request, Response, NextFunction } from 'express';
import * as YouTubeApiKeyModel from '../../models/youtube-api-key';

const router = Router();

type AuthedRequest = Request & { user?: { id: string } };

// ── List ─────────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeInactive = req.query.includeInactive === 'true' || req.query.includeInactive === '1';
    const keys = await YouTubeApiKeyModel.listKeys(includeInactive);
    res.json({ keys });
  } catch (err) {
    next(err);
  }
});

// ── Create ────────────────────────────────────────────────────────────────

router.post('/', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { label, partner, secret, daily_quota } = req.body as {
      label?: string;
      partner?: string | null;
      secret?: string;
      daily_quota?: number;
    };
    if (!label || !label.trim()) {
      res.status(400).json({ error: 'label required' });
      return;
    }
    if (!secret || !secret.trim()) {
      res.status(400).json({ error: 'secret required' });
      return;
    }
    if (daily_quota !== undefined && (!Number.isInteger(daily_quota) || daily_quota <= 0)) {
      res.status(400).json({ error: 'daily_quota must be a positive integer' });
      return;
    }
    const key = await YouTubeApiKeyModel.createKey({
      label: label.trim(),
      partner: partner?.trim() || null,
      secret: secret.trim(),
      daily_quota,
      created_by: req.user?.id ?? null,
    });
    res.status(201).json(key);
  } catch (err) {
    next(err);
  }
});

// ── Update ────────────────────────────────────────────────────────────────

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const { label, partner, secret, daily_quota, is_active } = req.body as {
      label?: string;
      partner?: string | null;
      secret?: string;
      daily_quota?: number;
      is_active?: boolean;
    };
    if (daily_quota !== undefined && (!Number.isInteger(daily_quota) || daily_quota <= 0)) {
      res.status(400).json({ error: 'daily_quota must be a positive integer' });
      return;
    }
    const updated = await YouTubeApiKeyModel.updateKey(id, {
      label: label?.trim(),
      partner: partner === undefined ? undefined : (partner?.trim() || null),
      secret: secret?.trim() || undefined,
      daily_quota,
      is_active,
    });
    if (!updated) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── Delete (soft) ─────────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const ok = await YouTubeApiKeyModel.deleteKey(id);
    if (!ok) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
