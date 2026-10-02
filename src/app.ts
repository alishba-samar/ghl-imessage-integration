import express, { type ErrorRequestHandler } from 'express';
import { env } from './config/env';
import { prisma } from './config/db';
import { devRouter } from './routes/dev';
import { ghlWebhooksRouter } from './routes/ghlWebhooks';
import { ghlWorkflowRouter } from './routes/ghlWorkflow';
import { imessageRouter } from './routes/imessage';
import { oauthRouter } from './routes/oauth';
import { webhooksRouter } from './routes/webhooks';
import { logger } from './utils/logger';
import type { RawBodyRequest } from './types/http';

export function createApp() {
  const app = express();

  // Keep the raw bytes: GHL signs the exact request body (X-GHL-Signature), and re-serializing
  // parsed JSON would not reproduce them.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: 'connected' });
    } catch (err) {
      logger.error({ err }, 'Health check DB query failed');
      res.status(503).json({ ok: false, db: 'disconnected' });
    }
  });

  app.use('/oauth', oauthRouter);
  app.use('/api/imessage', imessageRouter);
  app.use('/api/ghl/workflow', ghlWorkflowRouter);
  app.use('/webhooks/imessage', webhooksRouter);
  app.use('/webhooks/ghl', ghlWebhooksRouter);

  if (env.NODE_ENV !== 'production') {
    app.use('/dev', devRouter);
  }

  app.use(errorHandler);

  return app;
}

// Express 5 forwards rejected async handlers here. Client errors (e.g. malformed JSON) carry a 4xx status.
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  res.status(status).json({ error: status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST' });
};
