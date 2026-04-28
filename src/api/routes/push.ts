/**
 * Web Push API endpoints.
 *
 * /api/push/vapid-public-key  — GET, returns the active VAPID public key.
 *                              Public (no auth) — clients need it before
 *                              they can subscribe.
 * /api/push/subscribe         — POST, requires editor+. Stores subscription.
 * /api/push/unsubscribe       — POST, requires editor+. Deletes by endpoint.
 * /api/push/preferences       — GET / PUT, requires editor+. Per-device
 *                              event-type toggle map.
 * /api/push/test              — POST, requires admin. Sends test push.
 * /api/push/subscriptions     — GET, requires editor+. Lists caller's devices.
 *
 * The /api/push prefix is mounted in server.ts; the public vapid-public-key
 * endpoint is registered separately under a public sub-mount because the
 * `/api` prefix has authenticate() applied first.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getPushNotifier } from '../../services/push-notifier';
import * as PushSubscriptionModel from '../../models/push-subscription';
import { ALL_EVENT_TYPES } from '../../models/push-subscription';
import type { PushPreferences } from '../../models/push-subscription';
import logger from '../../utils/logger';

// ── Public router (no auth) ────────────────────────────────────────────────
// Mounted at /api/push-public for the VAPID public key endpoint.

export const pushPublicRouter = Router();

pushPublicRouter.get('/vapid-public-key', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const notifier = getPushNotifier();
    const key = notifier.getPublicKey();
    if (!key) {
      res.status(503).json({ error: 'Push notifications not yet initialised' });
      return;
    }
    res.json({ publicKey: key });
  } catch (err) {
    next(err);
  }
});

// ── Authenticated router ───────────────────────────────────────────────────

const router = Router();

// POST /api/push/subscribe — register / update a subscription
router.post('/subscribe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { subscription, preferences, userAgent } = req.body as {
      subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      preferences?: Partial<PushPreferences>;
      userAgent?: string;
    };

    if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
      res.status(400).json({ error: 'Invalid subscription payload' });
      return;
    }

    const saved = await PushSubscriptionModel.upsert({
      user_id: req.user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_agent: (userAgent ?? (req.headers['user-agent'] as string) ?? null)?.slice(0, 255) ?? null,
      preferences,
    });

    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

// POST /api/push/unsubscribe — remove a subscription by endpoint
router.post('/unsubscribe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { endpoint } = req.body as { endpoint?: string };
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint required' });
      return;
    }
    const ok = await PushSubscriptionModel.deleteByEndpoint(endpoint, req.user.id);
    res.json({ ok });
  } catch (err) {
    next(err);
  }
});

// GET /api/push/subscriptions — list caller's devices
router.get('/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const subs = await PushSubscriptionModel.listForUser(req.user.id);
    res.json({ subscriptions: subs });
  } catch (err) {
    next(err);
  }
});

// PUT /api/push/preferences — update per-device prefs
router.put('/preferences', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { endpoint, preferences } = req.body as {
      endpoint?: string;
      preferences?: Partial<PushPreferences>;
    };
    if (!endpoint || !preferences) {
      res.status(400).json({ error: 'endpoint and preferences required' });
      return;
    }
    // Validate the keys
    for (const key of Object.keys(preferences)) {
      if (!ALL_EVENT_TYPES.includes(key as never)) {
        res.status(400).json({ error: `Unknown event type: ${key}` });
        return;
      }
    }
    const updated = await PushSubscriptionModel.updatePreferences(endpoint, req.user.id, preferences);
    if (!updated) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/push/test — send a test notification (admin only; mounted with requireRole)
router.post('/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const result = await getPushNotifier().sendTest(req.user.id);
    logger.info('Sent test push notification', { userId: req.user.id, ...result });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
