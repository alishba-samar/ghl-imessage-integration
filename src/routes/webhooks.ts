import { Router, type RequestHandler } from 'express';
import { verifyWebhookSecret } from '../middleware/verifyWebhookSecret';
import { handleInboundWebhook, handleStatusWebhook } from '../services/webhookService';
import { logger } from '../utils/logger';

export const webhooksRouter = Router();

webhooksRouter.use(verifyWebhookSecret);

/**
 * Wraps a webhook handler. Expected outcomes (ignored, unknown message, duplicate, stale) all get 200
 * so the provider doesn't retry them. Only unexpected failures (e.g. database down) get a 500: Sendblue
 * retries those up to 3 times, which is safe because the handlers are idempotent.
 */
function webhook(name: string, handle: (body: unknown) => Promise<string>): RequestHandler {
  return async (req, res) => {
    try {
      const outcome = await handle(req.body);
      res.status(200).json({ ok: true, outcome });
    } catch (err) {
      logger.error({ err, webhook: name }, 'Webhook processing failed');
      res.status(500).json({ ok: false });
    }
  };
}

webhooksRouter.post('/status', webhook('status', handleStatusWebhook));
webhooksRouter.post('/inbound', webhook('inbound', handleInboundWebhook));
