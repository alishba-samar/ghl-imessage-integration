import { z } from 'zod';
import { isUniqueViolation, prisma } from '../config/db';
import { env } from '../config/env';
import type { Message } from '../generated/prisma/client';
import { getProvider, type SendMessageResult } from '../providers';
import { logger } from '../utils/logger';
import { normalizeToE164 } from '../utils/phone';

export const sendIMessageInputSchema = z
  .object({
    locationId: z.string().trim().min(1),
    contactId: z.string().trim().min(1),
    phone: z.string().trim().min(1),
    message: z.string(),
    mediaUrl: z.url().optional(),
    campaignId: z.string().trim().min(1).optional(),
    campaignStep: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
    /** Set when GHL originated the send (Delivery URL); used to sync statuses back to GHL. */
    ghlMessageId: z.string().trim().min(1).optional(),
  })
  // Text is required unless there's media (GHL can send attachment-only messages).
  .refine((v) => v.message.length > 0 || v.mediaUrl, { path: ['message'], message: 'message is required when there is no mediaUrl' });

export type SendIMessageInput = z.input<typeof sendIMessageInputSchema>;

export type SendIMessageResult =
  | { ok: true; message: Message; /** True when an existing record was returned instead of sending. */ duplicate: boolean }
  | { ok: false; error: 'VALIDATION_ERROR'; details: string }
  | { ok: false; error: 'INVALID_PHONE'; details: string }
  | { ok: false; error: 'SUPPRESSED'; details: string };

export async function sendIMessage(rawInput: unknown): Promise<SendIMessageResult> {
  // a. Validate
  const parsed = sendIMessageInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: 'VALIDATION_ERROR', details: z.prettifyError(parsed.error) };
  }
  const input = parsed.data;

  // b. Normalize phone
  const phone = normalizeToE164(input.phone);
  if (!phone) {
    return { ok: false, error: 'INVALID_PHONE', details: `Invalid phone number: ${input.phone}` };
  }

  // c. Suppression check (suppressions are stored in E.164)
  const suppression = await prisma.suppression.findUnique({
    where: { locationId_phone: { locationId: input.locationId, phone } },
  });
  if (suppression) {
    return { ok: false, error: 'SUPPRESSED', details: `${phone} is suppressed (${suppression.reason})` };
  }

  // d. Idempotency
  const idempotencyKey =
    input.idempotencyKey ??
    `${input.locationId}-${input.contactId}-${input.campaignId ?? 'manual'}-${input.campaignStep ?? Date.now()}`;

  // A GHL message id is unique too: a GHL Delivery for a message we already reserved (workflow sends)
  // must find that row rather than create a second one.
  const dedupWhere = input.ghlMessageId
    ? { OR: [{ idempotencyKey }, { ghlMessageId: input.ghlMessageId }] }
    : { idempotencyKey };

  const existing = await prisma.message.findFirst({ where: dedupWhere });
  if (existing) {
    logger.info({ messageId: existing.id, idempotencyKey }, 'Duplicate send request; returning existing message');
    return { ok: true, message: existing, duplicate: true };
  }

  // e. Create the QUEUED row. The unique idempotencyKey / ghlMessageId make this the lock against concurrent duplicates.
  let message: Message;
  try {
    message = await createOutboundRow({ ...input, phone, idempotencyKey });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await prisma.message.findFirst({ where: dedupWhere });
      if (winner) {
        logger.info({ messageId: winner.id, idempotencyKey }, 'Concurrent duplicate send; returning existing message');
        return { ok: true, message: winner, duplicate: true };
      }
    }
    throw err;
  }

  // f-h. Send via provider, record and return the outcome
  return { ok: true, message: await dispatchMessage(message.id), duplicate: false };
}

/** Creates an OUTBOUND row in QUEUED state without sending it. The caller handles unique violations. */
export function createOutboundRow(input: {
  locationId: string;
  contactId: string;
  phone: string;
  message: string;
  mediaUrl?: string;
  campaignId?: string;
  campaignStep?: number;
  idempotencyKey: string;
  ghlMessageId?: string;
}): Promise<Message> {
  return prisma.message.create({
    data: {
      locationId: input.locationId,
      contactId: input.contactId,
      direction: 'OUTBOUND',
      phone: input.phone,
      status: 'QUEUED',
      body: input.message,
      mediaUrl: input.mediaUrl,
      campaignId: input.campaignId,
      campaignStep: input.campaignStep,
      idempotencyKey: input.idempotencyKey,
      ghlMessageId: input.ghlMessageId,
    },
  });
}

/**
 * Sends a QUEUED OUTBOUND row through the provider, exactly once. The row is claimed first by atomically
 * setting dispatchedAt; if another caller already claimed it (duplicate delivery, concurrent request),
 * nothing is sent and the current row is returned.
 */
export async function dispatchMessage(messageId: string): Promise<Message> {
  const claimed = await prisma.message.updateMany({
    where: { id: messageId, direction: 'OUTBOUND', status: 'QUEUED', dispatchedAt: null },
    data: { dispatchedAt: new Date() },
  });
  const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
  if (claimed.count === 0) {
    logger.info({ messageId, status: message.status }, 'Message already dispatched; not sending again');
    return message;
  }

  const now = new Date();
  if (!message.phone) {
    return prisma.message.update({
      where: { id: messageId },
      data: { status: 'FAILED', failedAt: now, errorCode: 'INVALID_PHONE', errorMessage: 'Message has no phone number' },
    });
  }

  // Re-check suppression: the contact may have opted out since the row was created (e.g. a reserved
  // workflow send waiting for GHL's Delivery call).
  const suppression = await prisma.suppression.findUnique({
    where: { locationId_phone: { locationId: message.locationId, phone: message.phone } },
  });
  if (suppression) {
    logger.info({ messageId }, 'Phone suppressed before dispatch; not sending');
    return prisma.message.update({
      where: { id: messageId },
      data: { status: 'FAILED', failedAt: now, errorCode: 'SUPPRESSED', errorMessage: `${message.phone} is suppressed (${suppression.reason})` },
    });
  }

  let result: SendMessageResult;
  try {
    result = await getProvider().sendMessage({
      to: message.phone,
      from: '', // provider default sender; per-location senders come later
      content: message.body,
      mediaUrl: message.mediaUrl ?? undefined,
      statusCallbackUrl: env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/webhooks/imessage/status` : undefined,
    });
  } catch (err) {
    // Providers shouldn't throw, but never leave the row stuck in QUEUED if one does.
    logger.error({ err, messageId }, 'Provider threw during sendMessage');
    result = {
      status: 'FAILED',
      errorCode: 'PROVIDER_EXCEPTION',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const done = new Date();
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      providerMessageId: result.providerMessageId,
      status: result.status,
      service: result.service,
      wasDowngraded: result.wasDowngraded,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      // QUEUED means the provider accepted it but hasn't sent yet; the status webhook sets sentAt later.
      sentAt: result.status === 'SENT' || result.status === 'DELIVERED' ? done : undefined,
      deliveredAt: result.status === 'DELIVERED' ? done : undefined,
      failedAt: result.status === 'FAILED' ? done : undefined,
    },
  });

  logger.info(
    { messageId: updated.id, status: updated.status, providerMessageId: updated.providerMessageId },
    'Outbound iMessage processed',
  );
  return updated;
}
