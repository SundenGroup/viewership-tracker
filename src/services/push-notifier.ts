/**
 * PushNotifier — sends Web Push notifications to subscribed devices.
 *
 * Initialised once at server boot. Auto-generates a VAPID keypair on first
 * run and stores it in `push_vapid_keys` (encrypted at rest). Subsequent
 * boots load and reuse it.
 *
 * Each `notify(eventType, payload)` call:
 *   1. Queries `push_subscriptions` for rows where `preferences[eventType] = true`
 *      (filtered to editor + admin roles via the model).
 *   2. Sends via web-push in parallel; uses `tag` so duplicates collapse.
 *   3. On 410-Gone / 404 (browser revoked subscription), deletes the row.
 *
 * Event throttling is the caller's responsibility (e.g. the orchestrator
 * tracks "polling_stalled was sent at <ts>" and skips if within 1h).
 */

import webpush from 'web-push';
import logger from '../utils/logger';
import * as OpsEventModel from '../models/ops-event';
import * as PushSubscriptionModel from '../models/push-subscription';
import * as PushVapidKeyModel from '../models/push-vapid-key';
import type { PushEventType, PushSubscriptionRow } from '../models/push-subscription';

export interface NotificationPayload {
  /** Notification title (shown bold in the notification). */
  title: string;
  /** Body text shown below the title. */
  body: string;
  /** URL to open when the user clicks the notification. Default: '/'. */
  url?: string;
  /**
   * Notification tag — same-tag notifications collapse on top of each
   * other, preventing spam. Defaults to the eventType.
   */
  tag?: string;
  /**
   * If true, set requireInteraction so the notification stays until the
   * user dismisses it (good for "polling stalled" / "quota exhausted").
   */
  urgent?: boolean;
}

export interface NotifyOptions {
  /**
   * Restrict fan-out to specific user roles. Defaults to ['admin', 'editor'].
   * Pass `undefined` to include all roles (i.e. viewers too).
   */
  roles?: ('admin' | 'editor' | 'viewer')[] | null;
}

const DEFAULT_ROLES: ('admin' | 'editor' | 'viewer')[] = ['admin', 'editor'];

export class PushNotifier {
  private vapidPublicKey: string | null = null;
  private contactEmail: string | null = null;
  private initialised = false;

  /**
   * Initialise — load (or generate) the VAPID keypair and configure web-push.
   * Idempotent; safe to call multiple times.
   */
  async init(contactEmail: string = 'simon@clutch.game'): Promise<void> {
    if (this.initialised) return;

    let key = await PushVapidKeyModel.getActive();
    if (!key) {
      const generated = webpush.generateVAPIDKeys();
      key = await PushVapidKeyModel.create({
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
        contactEmail,
      });
      logger.info('Generated new VAPID keypair for Web Push', {
        publicKeyPrefix: generated.publicKey.slice(0, 16) + '…',
      });
    }

    webpush.setVapidDetails(`mailto:${key.contactEmail}`, key.publicKey, key.privateKey);
    this.vapidPublicKey = key.publicKey;
    this.contactEmail = key.contactEmail;
    this.initialised = true;
    logger.info('PushNotifier initialised', { publicKeyPrefix: key.publicKey.slice(0, 16) + '…' });
  }

  /** Public VAPID key — clients need it to subscribe via PushManager. */
  getPublicKey(): string | null {
    return this.vapidPublicKey;
  }

  /** Send a notification to all subscribers for an event type. */
  async notify(
    eventType: PushEventType,
    payload: NotificationPayload,
    options: NotifyOptions = {},
  ): Promise<{ sent: number; failed: number; pruned: number }> {
    if (!this.initialised) {
      logger.warn('PushNotifier.notify called before init — skipping', { eventType });
      return { sent: 0, failed: 0, pruned: 0 };
    }

    const roles = options.roles === null ? undefined : options.roles ?? DEFAULT_ROLES;
    const subs = await PushSubscriptionModel.findSubscribersForEvent(eventType, { roles });

    if (subs.length === 0) {
      logger.debug('No subscribers for event', { eventType });
      // Still persist to history — "nobody was subscribed" is exactly the
      // case where the reviewable log matters most.
      await OpsEventModel.record({
        eventType,
        title: payload.title,
        body: payload.body,
        url: payload.url ?? null,
        urgent: payload.urgent === true,
      });
      return { sent: 0, failed: 0, pruned: 0 };
    }

    const messageBody = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? '/',
      tag: payload.tag ?? eventType,
      urgent: payload.urgent === true,
    });

    const results = await Promise.allSettled(
      subs.map((sub) => this.sendOne(sub, messageBody)),
    );

    let sent = 0;
    let failed = 0;
    let pruned = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const sub = subs[i];
      if (r.status === 'fulfilled') {
        sent++;
        await PushSubscriptionModel.touchLastNotified(sub.endpoint);
      } else {
        const reason = r.reason as { statusCode?: number; message?: string };
        if (reason?.statusCode === 410 || reason?.statusCode === 404) {
          await PushSubscriptionModel.deleteByEndpoint(sub.endpoint);
          pruned++;
        } else {
          failed++;
          logger.warn('Web Push send failed', {
            endpoint: sub.endpoint.slice(0, 60) + '…',
            statusCode: reason?.statusCode,
            message: reason?.message,
          });
        }
      }
    }

    logger.info('Push notification fan-out', { eventType, sent, failed, pruned, total: subs.length });
    await OpsEventModel.record({
      eventType,
      title: payload.title,
      body: payload.body,
      url: payload.url ?? null,
      urgent: payload.urgent === true,
      sent,
      failed,
      pruned,
    });
    return { sent, failed, pruned };
  }

  /** Send a test notification to a single user's subscriptions. */
  async sendTest(userId: string): Promise<{ sent: number; failed: number; pruned: number }> {
    if (!this.initialised) {
      throw new Error('PushNotifier not initialised');
    }
    const subs = await PushSubscriptionModel.listForUser(userId);
    if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0 };

    const messageBody = JSON.stringify({
      title: 'Test notification',
      body: 'If you can see this, push notifications are working on this device.',
      url: '/settings/notifications',
      tag: 'test',
      urgent: false,
    });

    let sent = 0;
    let failed = 0;
    let pruned = 0;
    // Need full rows (with p256dh, auth) for the send — listForUser returns
    // public, so we re-fetch by endpoint.
    for (const sub of subs) {
      const full = await PushSubscriptionModel.findByEndpoint(sub.endpoint);
      if (!full) continue;
      try {
        await this.sendOne(full, messageBody);
        sent++;
      } catch (err) {
        const reason = err as { statusCode?: number };
        if (reason?.statusCode === 410 || reason?.statusCode === 404) {
          await PushSubscriptionModel.deleteByEndpoint(full.endpoint);
          pruned++;
        } else {
          failed++;
        }
      }
    }
    return { sent, failed, pruned };
  }

  private async sendOne(sub: PushSubscriptionRow, payloadJson: string): Promise<void> {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      payloadJson,
      { TTL: 60 * 60 * 6 }, // 6 hours — drop if undelivered after that
    );
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

let instance: PushNotifier | null = null;

export function getPushNotifier(): PushNotifier {
  if (!instance) instance = new PushNotifier();
  return instance;
}
