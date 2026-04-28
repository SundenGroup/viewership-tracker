/**
 * VAPID keypair used by Web Push.
 *
 * One active row at a time. The private key is encrypted at rest with
 * AES-256-GCM keyed off JWT_SECRET (same pattern as youtube_api_keys).
 * Rotating the keypair is destructive — every existing browser subscription
 * will fail with a 401 from the push service and need to re-subscribe.
 */

import db from '../utils/db';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import logger from '../utils/logger';

const TABLE = 'push_vapid_keys';

export interface PushVapidKeyRow {
  id: string;
  public_key: string;
  private_key_encrypted: string;
  contact_email: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ResolvedVapidKey {
  id: string;
  publicKey: string;
  privateKey: string; // decrypted, in-memory only
  contactEmail: string;
}

export async function getActive(): Promise<ResolvedVapidKey | null> {
  const row = await db<PushVapidKeyRow>(TABLE)
    .where({ is_active: true })
    .orderBy('created_at', 'desc')
    .first();
  if (!row) return null;
  try {
    return {
      id: row.id,
      publicKey: row.public_key,
      privateKey: decryptSecret(row.private_key_encrypted),
      contactEmail: row.contact_email,
    };
  } catch (err) {
    logger.error('Failed to decrypt VAPID private key', { error: (err as Error).message });
    return null;
  }
}

export async function create(data: {
  publicKey: string;
  privateKey: string;
  contactEmail: string;
}): Promise<ResolvedVapidKey> {
  // Deactivate any existing active rows first
  await db<PushVapidKeyRow>(TABLE).where({ is_active: true }).update({
    is_active: false,
    updated_at: db.fn.now() as unknown as string,
  });
  const [row] = await db<PushVapidKeyRow>(TABLE)
    .insert({
      public_key: data.publicKey,
      private_key_encrypted: encryptSecret(data.privateKey),
      contact_email: data.contactEmail,
      is_active: true,
    })
    .returning('*');
  return {
    id: row.id,
    publicKey: row.public_key,
    privateKey: data.privateKey,
    contactEmail: row.contact_email,
  };
}
