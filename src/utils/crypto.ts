/**
 * AES-256-GCM at-rest encryption for sensitive fields (e.g. third-party API
 * secrets stored in the DB).
 *
 * The encryption key is derived from JWT_SECRET via SHA-256 — no extra
 * env var to manage. If JWT_SECRET rotates, all encrypted fields become
 * unreadable, so JWT_SECRET should be treated as forever-stable in
 * production. The format on disk is:
 *
 *   <iv:hex>:<authTag:hex>:<ciphertext:hex>
 *
 * which is opaque to the rest of the system but parseable here.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from './config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;

function deriveKey(): Buffer {
  const secret = config.auth.jwtSecret;
  if (!secret || secret === 'dev-only-insecure-secret') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET required for at-rest encryption');
    }
  }
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = deriveKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted payload metadata');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Mask a secret as "AIzaS…<last 4>" — never returns more than the last 4 chars. */
export function maskSecret(secret: string): string {
  if (!secret || secret.length <= 8) return '••••';
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`;
}
