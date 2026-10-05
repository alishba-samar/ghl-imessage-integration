import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { connectLocationFromAgency } from '../ghl/agency';
import { verifyGhlSignature } from '../middleware/verifyGhlSignature';
import { failGhlMessage, syncStatusToGhl } from '../services/ghlSyncService';
import { dispatchMessage, sendIMessage } from '../services/sendService';
import { runInBackground } from '../utils/background';
import { logger } from '../utils/logger';

export const ghlWebhooksRouter = Router();

// Conversation Provider Outbound Message payload (SMS), per
// https://marketplace.gohighlevel.com/docs/webhook/ProviderOutboundMessage
const outboundSchema = z.object({
  locationId: z.string().min(1),
  contactId: z.string().min(1),
  messageId: z.string().min(1),
  type: z.string(),
  phone: z.string().optional(),
  message: z.string().optional(),
  attachments: z.array(z.string()).optional(),
  userId: z.string().optional(),
});

type OutboundPayload = z.infer<typeof outboundSchema>;

/**
 * Delivery URL for our custom conversation provider: GHL calls this when a user (or workflow) sends an
 * iMessage. Verified, then acknowledged immediately with 200; the send runs in the background and its
 * result is reported back via GHL's Update message status API. GHL retries any non-2xx up to 12 times,
 * so only a bad signature gets a non-2xx response.
 */
ghlWebhooksRouter.post('/outbound-imessage', verifyGhlSignature, (req, res) => {
  const parsed = outboundSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues.map((i) => i.path.join('.')) }, 'GHL outbound payload invalid; ignored');
    res.status(200).json({ ok: false, error: 'INVALID_PAYLOAD' });
    return;
  }
  if (parsed.data.type !== 'SMS') {
    logger.warn({ type: parsed.data.type, messageId: parsed.data.messageId }, 'GHL outbound payload is not SMS; ignored');
    res.status(200).json({ ok: false, error: 'UNSUPPORTED_TYPE' });
    return;
  }

  res.status(200).json({ ok: true });
  runInBackground('ghl-outbound-send', () => processOutbound(parsed.data));
});

async function processOutbound(payload: OutboundPayload): Promise<void> {
  const { locationId, contactId, messageId: ghlMessageId } = payload;
  if (payload.attachments && payload.attachments.length > 1) {
    logger.warn({ ghlMessageId, count: payload.attachments.length }, 'Only the first attachment is sent');
  }

  const result = await sendIMessage({
    locationId,
    contactId,
    phone: payload.phone ?? '',
    message: payload.message ?? '',
    mediaUrl: payload.attachments?.[0],
    idempotencyKey: ghlMessageId,
    ghlMessageId,
  });

  if (!result.ok) {
    logger.warn({ ghlMessageId, locationId, error: result.error }, 'GHL outbound message not sent');
    // A row reserved by the workflow endpoint for this GHL message would otherwise stay QUEUED forever.
    await prisma.message.updateMany({
      where: { ghlMessageId, status: 'QUEUED', dispatchedAt: null },
      data: { status: 'FAILED', failedAt: new Date(), errorCode: result.error, errorMessage: result.details },
    });
    await failGhlMessage(locationId, ghlMessageId, result.error, result.details);
    return;
  }
  if (result.duplicate) {
    // Either a repeated Delivery (already dispatched: dispatchMessage is a no-op) or a row reserved by
    // /api/ghl/workflow/send-imessage that is waiting for this Delivery to be sent.
    const before = result.message.dispatchedAt;
    const message = await dispatchMessage(result.message.id);
    if (before) {
      logger.info({ ghlMessageId, messageId: message.id }, 'Duplicate GHL outbound delivery; not sent again');
      return;
    }
  }
  await syncStatusToGhl(result.message.id);
}

// Marketplace app webhook (App Install event), per https://marketplace.gohighlevel.com/docs/webhook/AppInstall
// and Authorization/TargetUserSubAccount: when an agency installs the app on a (new) location, GHL sends
// { type: "INSTALL", installType: "Location", locationId, companyId, ... }. We mint that location's token
// from the stored agency token. Other events are acknowledged and ignored.
const appEventSchema = z.object({
  type: z.string(),
  installType: z.string().optional(),
  locationId: z.string().optional(),
  companyId: z.string().optional(),
});

ghlWebhooksRouter.post('/app', verifyGhlSignature, (req, res) => {
  const parsed = appEventSchema.safeParse(req.body);
  res.status(200).json({ ok: true });
  if (!parsed.success) {
    logger.warn('GHL app webhook payload not recognized; ignored');
    return;
  }
  const event = parsed.data;
  if (event.type !== 'INSTALL' || !event.locationId || !event.companyId) {
    logger.info({ type: event.type, installType: event.installType }, 'GHL app webhook ignored');
    return;
  }
  const { companyId, locationId } = event;
  runInBackground('ghl-app-install', async () => {
    const [integration, agency] = await Promise.all([
      prisma.integration.findUnique({ where: { locationId }, select: { id: true } }),
      prisma.agencyIntegration.findUnique({ where: { companyId }, select: { id: true } }),
    ]);
    if (integration) {
      logger.info({ locationId }, 'App install webhook: location already connected');
      return;
    }
    if (!agency) {
      // A sub-account user installed it themselves: their OAuth callback brings a Location token instead.
      logger.info({ locationId, companyId }, 'App install webhook: no agency token for this company; waiting for OAuth callback');
      return;
    }
    await connectLocationFromAgency(companyId, locationId);
  });
});
