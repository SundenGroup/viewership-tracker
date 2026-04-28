/**
 * Web Push client service.
 *
 * Wraps the browser's Service Worker registration + PushManager so the
 * NotificationsSettingsPage can stay clean. All side effects (SW registration,
 * permission prompt, subscribe/unsubscribe) live here.
 *
 * Browser support matrix:
 *   Chrome/Edge desktop+Android  — full support, no install required
 *   Firefox desktop+Android      — full support, no install required
 *   Safari iOS 16.4+             — only inside an installed PWA (home-screen)
 *   Safari macOS 16.1+           — supported in Safari 16.4 (March 2023)+
 */

import * as api from './api';

const SW_PATH = '/sw.js';

export type PushSupportStatus =
  | 'supported'        // Browser has SW + PushManager + Notifications
  | 'permission-default' // supported, user hasn't decided
  | 'permission-granted' // supported + user granted permission
  | 'permission-denied'  // user clicked Block
  | 'unsupported-ios-safari' // iOS Safari not in PWA mode
  | 'unsupported';      // Browser is missing SW or PushManager

export interface PushStatus {
  status: PushSupportStatus;
  isStandalone: boolean;
  isIOS: boolean;
  isSubscribed: boolean;
  endpoint: string | null;
}

// ── Detection helpers ─────────────────────────────────────────────────────

function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  return /iP(ad|hone|od)/.test(ua) && /Safari/.test(ua) && !/(CriOS|FxiOS)/.test(ua);
}

function isStandalone(): boolean {
  // iOS-specific, plus the cross-browser display-mode media query
  return (
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    // @ts-expect-error — iOS Safari only
    window.navigator.standalone === true
  );
}

// ── Service Worker registration ───────────────────────────────────────────

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker.register(SW_PATH).then(
      (reg) => reg,
      (err) => {
        console.warn('[push] Service Worker registration failed', err);
        return null;
      },
    );
  }
  return swRegistrationPromise;
}

// ── Status ────────────────────────────────────────────────────────────────

export async function getPushStatus(): Promise<PushStatus> {
  const ios = isIOSSafari();
  const standalone = isStandalone();

  // No SW or PushManager — bail out
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return {
      status: ios && !standalone ? 'unsupported-ios-safari' : 'unsupported',
      isStandalone: standalone,
      isIOS: ios,
      isSubscribed: false,
      endpoint: null,
    };
  }

  // iOS without home-screen install — Web Push won't work
  if (ios && !standalone) {
    return {
      status: 'unsupported-ios-safari',
      isStandalone: false,
      isIOS: true,
      isSubscribed: false,
      endpoint: null,
    };
  }

  const reg = await ensureServiceWorker();
  if (!reg) {
    return {
      status: 'unsupported',
      isStandalone: standalone,
      isIOS: ios,
      isSubscribed: false,
      endpoint: null,
    };
  }

  const sub = await reg.pushManager.getSubscription();
  const perm = Notification.permission;

  let status: PushSupportStatus;
  if (perm === 'granted') status = 'permission-granted';
  else if (perm === 'denied') status = 'permission-denied';
  else status = 'permission-default';

  return {
    status,
    isStandalone: standalone,
    isIOS: ios,
    isSubscribed: Boolean(sub),
    endpoint: sub?.endpoint ?? null,
  };
}

// ── Subscribe / Unsubscribe ───────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

export async function enablePush(): Promise<{ ok: true; endpoint: string } | { ok: false; reason: string }> {
  if (!('Notification' in window)) {
    return { ok: false, reason: 'This browser does not support notifications.' };
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return { ok: false, reason: 'Notification permission was not granted.' };
  }

  const reg = await ensureServiceWorker();
  if (!reg) {
    return { ok: false, reason: 'Service Worker registration failed.' };
  }

  // Fetch the VAPID public key from the server
  let vapidPublicKey: string;
  try {
    const r = await api.getVapidPublicKey();
    vapidPublicKey = r.publicKey;
  } catch (err) {
    return { ok: false, reason: `Could not load VAPID public key: ${(err as Error).message}` };
  }

  // Subscribe via PushManager
  let subscription: PushSubscription;
  try {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  } catch (err) {
    return { ok: false, reason: `PushManager.subscribe failed: ${(err as Error).message}` };
  }

  // Send to server
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, reason: 'Browser returned an incomplete subscription.' };
  }
  try {
    await api.subscribeToPush({
      endpoint: json.endpoint,
      expirationTime: json.expirationTime ?? null,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
  } catch (err) {
    // Server rejected — undo the browser-side subscription
    try {
      await subscription.unsubscribe();
    } catch (_e) {
      // ignore
    }
    return { ok: false, reason: `Server rejected the subscription: ${(err as Error).message}` };
  }

  return { ok: true, endpoint: json.endpoint };
}

export async function disablePush(): Promise<{ ok: boolean; reason?: string }> {
  const reg = await ensureServiceWorker();
  if (!reg) return { ok: false, reason: 'No Service Worker registered.' };

  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { ok: true }; // already off

  // Tell the server first so the row gets deleted even if the browser
  // unsubscribe call fails for some reason.
  try {
    await api.unsubscribeFromPush(sub.endpoint);
  } catch (err) {
    console.warn('[push] Server unsubscribe failed', err);
  }
  try {
    await sub.unsubscribe();
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  return { ok: true };
}
