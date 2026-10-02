import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Constant-time string comparison. Hashing first gives both sides a fixed length,
 * so neither the content nor the length of the secret leaks through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// --- Encryption at rest (AES-256-GCM) ---
// Format: "v1:" + base64(iv[12] | authTag[16] | ciphertext). The version prefix allows key rotation later.

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | undefined;
function encryptionKey(): Buffer {
  // Length (32 bytes) is validated in env.ts at startup.
  cachedKey ??= Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
}

/** Throws if the value was not produced by encryptSecret with the current key, or was tampered with. */
export function decryptSecret(stored: string): string {
  const [version, payload] = stored.split(':', 2);
  if (version !== VERSION || !payload) throw new Error('Unrecognized encrypted value format');
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Encrypted value is truncated');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}
