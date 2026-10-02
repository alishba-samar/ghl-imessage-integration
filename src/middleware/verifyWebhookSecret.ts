import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { safeEqual } from '../utils/crypto';

// Sendblue echoes the secret configured on the webhook in this header (not an HMAC signature).
const HEADER = 'sb-signing-secret';

let warnedMissingSecret = false;

/**
 * If SENDBLUE_WEBHOOK_SECRET is set, the sb-signing-secret header must match it.
 * If it isn't set, requests are allowed outside production (with a one-time warning) and
 * rejected in production, so a missing secret can't silently expose the webhooks.
 */
export const verifyWebhookSecret: RequestHandler = (req, res, next) => {
  const secret = env.SENDBLUE_WEBHOOK_SECRET;

  if (!secret) {
    if (env.NODE_ENV === 'production') {
      logger.error({ path: req.path }, 'SENDBLUE_WEBHOOK_SECRET is not set; rejecting webhook in production');
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    if (!warnedMissingSecret) {
      logger.warn('SENDBLUE_WEBHOOK_SECRET is not set; accepting unauthenticated webhooks (dev only)');
      warnedMissingSecret = true;
    }
    next();
    return;
  }

  const provided = req.header(HEADER);
  if (!provided || !safeEqual(provided, secret)) {
    logger.warn({ path: req.path, headerPresent: !!provided }, 'Webhook rejected: bad or missing signing secret');
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  next();
};
