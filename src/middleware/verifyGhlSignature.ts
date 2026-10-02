import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../config/env';
import type { RawBodyRequest } from '../types/http';
import { logger } from '../utils/logger';

// Ed25519 public key for X-GHL-Signature, as published in GHL's Webhook Integration Guide and the
// Provider Outbound Message docs (https://marketplace.gohighlevel.com/docs/webhook/ProviderOutboundMessage).
const DOCUMENTED_GHL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

const publicKey: KeyObject = createPublicKey(
  env.GHL_WEBHOOK_PUBLIC_KEY ? env.GHL_WEBHOOK_PUBLIC_KEY.replace(/\\n/g, '\n') : DOCUMENTED_GHL_PUBLIC_KEY,
);

/**
 * Verifies X-GHL-Signature: a base64 Ed25519 signature over the raw request body bytes.
 * Delivery URL posts carry only this header (not the legacy X-WH-Signature). Rejects with 401 before
 * any processing if the header is missing or the signature doesn't verify.
 */
export const verifyGhlSignature: RequestHandler = (req, res, next) => {
  const signature = req.header('x-ghl-signature');
  const rawBody = (req as RawBodyRequest).rawBody;

  let ok = false;
  if (signature && signature !== 'N/A' && rawBody) {
    try {
      ok = verify(null, rawBody, publicKey, Buffer.from(signature, 'base64'));
    } catch {
      ok = false;
    }
  }

  if (!ok) {
    logger.warn({ path: req.path, signaturePresent: !!signature, hasBody: !!rawBody }, 'GHL webhook rejected: invalid signature');
    res.status(401).json({ error: 'INVALID_SIGNATURE' });
    return;
  }
  next();
};
