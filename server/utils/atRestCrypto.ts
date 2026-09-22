// At-rest encryption for exporter secrets (MQTT password, InfluxDB token,
// Telegram bot token) stored in the app_config table. AES-256-GCM with a key
// derived from ENCRYPTION_KEY if set, else JWT_SECRET (already required in
// production, so this works with zero new required config).
//
// Format: `gvr1:<iv-b64>:<tag-b64>:<ciphertext-b64>`. decrypt() treats any
// value without the `gvr1:` prefix as legacy plaintext and returns it
// unchanged — existing installs upgrade transparently: their old plaintext
// secrets keep working and get re-encrypted the next time they're saved.
//
// Caveat: rotating whichever of ENCRYPTION_KEY/JWT_SECRET is in use as key
// material makes previously-encrypted secrets undecryptable (decrypt()
// falls back to '' and logs a warning rather than throwing) — the admin
// re-enters them in Settings. No crash, no data loss beyond those three
// fields. Setting a dedicated ENCRYPTION_KEY decouples this from JWT_SECRET
// rotations done for auth reasons.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { config } from '../config.js';
import { logger } from './logger.js';

const PREFIX = 'gvr1:';
const ALGO = 'aes-256-gcm';
const KEY_SALT = 'gpuviewr-export-secrets-v1';

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (!cachedKey) {
    // Prefer a dedicated ENCRYPTION_KEY (decouples secret-at-rest
    // encryption from JWT signing, so rotating JWT_SECRET for an auth
    // reason doesn't collaterally break decryption of stored exporter
    // secrets). Falls back to jwtSecret when unset — no existing
    // install needs a new env var to keep working.
    const material = config.encryptionKey || config.jwtSecret;
    cachedKey = scryptSync(material, KEY_SALT, 32);
  }
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptSecret(value: string): string {
  if (!value) return '';
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext, pass through
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return '';
  try {
    const [ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    logger.warn('crypto', `Failed to decrypt stored secret (JWT_SECRET rotated?): ${(err as Error).message}`);
    return '';
  }
}
