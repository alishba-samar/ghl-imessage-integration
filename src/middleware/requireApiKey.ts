import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { safeEqual } from '../utils/crypto';

// Temporary POC auth: x-api-key must equal INTERNAL_API_KEY. Replaced by GHL auth later.
export const requireApiKey: RequestHandler = (req, res, next) => {
  const provided = req.header('x-api-key');
  if (!provided || !safeEqual(provided, env.INTERNAL_API_KEY)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  next();
};
