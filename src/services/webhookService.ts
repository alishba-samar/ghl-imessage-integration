import { isUniqueViolation, prisma } from '../config/db';
import type { MessageStatus, Prisma } from '../generated/prisma/client';
import { getProvider, type StatusUpdate } from '../providers';
import { syncInboundToGhl, syncStatusToGhl } from './ghlSyncService';
import { runInBackground } from '../utils/background';
import { logger } from '../utils/logger';
import { normalizeToE164 } from '../utils/phone';

/** Used for locationId / contactId when an inbound message can't be linked to an earlier send. */
export const UNKNOWN = 'unknown';

/**
 * Statuses a message may move *from* to reach each target status.
 * Order: QUEUED < SENT < DELIVERED < READ. FAILED only from QUEUED or SENT.
 * Anything else (backwards moves, repeats, changes after FAILED) is ignored, which also makes
 * duplicate webhooks no-ops.
 */
const ALLOWED_FROM: Record<StatusUpdate['status'], MessageStatus[]> = {
  SENT: ['QUEUED'],
  DELIVERED: ['QUEUED', 'SENT'],
  READ: ['QUEUED', 'SENT', 'DELIVERED'],
  FAILED: ['QUEUED', 'SENT'],
};

export type StatusWebhookOutcome = 'ignored' | 'not_found' | 'updated' | 'stale';

export async function handleStatusWebhook(body: unknown): Promise<StatusWebhookOutcome> {
  const update = getProvider().parseStatusWebhook(body);
  if (!update) return 'ignored'; // in-progress status or unrecognized payload
  return applyStatusUpdate(update);
}

/**
 * Applies a provider status update to the matching OUTBOUND message, never moving status backwards.
 * Shared by the status webhook and status polling (getMessageStatus).
 */
export async function applyStatusUpdate(update: StatusUpdate): Promise<Exclude<StatusWebhookOutcome, 'ignored'>> {
  const message = await prisma.message.findFirst({
    where: { providerMessageId: update.providerMessageId, direction: 'OUTBOUND' },
  });
  if (!message) {
    logger.warn({ providerMessageId: update.providerMessageId, status: update.status }, 'Status webhook for unknown message');
    return 'not_found';
  }

  const now = new Date();
  const data: Prisma.MessageUpdateManyMutationInput = {
    status: update.status,
    service: update.service,
    wasDowngraded: update.wasDowngraded,
  };
  // Backfill earlier timestamps when a status is skipped (e.g. QUEUED -> DELIVERED).
  switch (update.status) {
    case 'SENT':
      data.sentAt = message.sentAt ?? now;
      break;
    case 'DELIVERED':
      data.sentAt = message.sentAt ?? now;
      data.deliveredAt = now;
      break;
    case 'READ':
      data.sentAt = message.sentAt ?? now;
      data.deliveredAt = message.deliveredAt ?? now;
      data.readAt = now;
      break;
    case 'FAILED':
      data.failedAt = now;
      data.errorCode = update.errorCode;
      data.errorMessage = update.errorMessage;
      break;
  }

  // The status condition is checked in the same statement as the write, so concurrent or
  // duplicate webhooks can't move the status backwards.
  const { count } = await prisma.message.updateMany({
    where: { id: message.id, status: { in: ALLOWED_FROM[update.status] } },
    data,
  });

  if (count === 0) {
    logger.info(
      { messageId: message.id, current: message.status, incoming: update.status },
      'Status webhook ignored (duplicate or out of order)',
    );
    return 'stale';
  }

  logger.info(
    { messageId: message.id, from: message.status, to: update.status, isPermanentFailure: update.isPermanentFailure },
    'Message status updated',
  );

  // GHL-originated messages: mirror the status in GHL after the provider gets its response.
  if (message.ghlMessageId) runInBackground('ghl-status-sync', () => syncStatusToGhl(message.id));
  // TODO(retry): when status is FAILED and isPermanentFailure is false, schedule a retry (retryCount).

  return 'updated';
}

export type InboundWebhookOutcome = 'ignored' | 'duplicate' | 'saved';

export async function handleInboundWebhook(body: unknown): Promise<InboundWebhookOutcome> {
  const provider = getProvider();
  const inbound = provider.parseInboundWebhook(body);
  if (!inbound) return 'ignored';

  const existing = await prisma.message.findFirst({
    where: { providerMessageId: inbound.providerMessageId },
    select: { id: true },
  });
  if (existing) return 'duplicate';

  const phone = normalizeToE164(inbound.from) ?? inbound.from;

  // Link to the conversation via the most recent message we sent to this phone.
  const lastOutbound = await prisma.message.findFirst({
    where: { phone, direction: 'OUTBOUND' },
    orderBy: { createdAt: 'desc' },
    select: { locationId: true, contactId: true },
  });
  const locationId = lastOutbound?.locationId ?? UNKNOWN;
  const contactId = lastOutbound?.contactId ?? UNKNOWN;
  if (!lastOutbound) {
    logger.warn({ phone, providerMessageId: inbound.providerMessageId }, 'Inbound message from a phone we never messaged');
  }

  let messageId: string;
  try {
    const created = await prisma.message.create({
      data: {
        locationId,
        contactId,
        direction: 'INBOUND',
        phone,
        body: inbound.content,
        mediaUrl: inbound.mediaUrl,
        providerMessageId: inbound.providerMessageId,
        status: 'DELIVERED',
        deliveredAt: inbound.receivedAt,
        // Unique key: closes the race where the same webhook is delivered twice concurrently.
        idempotencyKey: `inbound:${provider.name}:${inbound.providerMessageId}`,
      },
      select: { id: true },
    });
    messageId = created.id;
  } catch (err) {
    if (isUniqueViolation(err)) return 'duplicate';
    throw err;
  }

  logger.info({ messageId, locationId, contactId, phone }, 'Inbound message saved');

  const optOut = isOptOut(inbound.content);
  if (optOut) {
    if (locationId === UNKNOWN) {
      logger.warn({ phone }, 'Opt-out from an unlinked phone; suppression stored under locationId "unknown"');
    }
    // Upsert keeps this idempotent: repeated STOPs leave the original suppression in place.
    await prisma.suppression.upsert({
      where: { locationId_phone: { locationId, phone } },
      create: { locationId, phone, contactId: contactId === UNKNOWN ? null : contactId, reason: 'STOP' },
      update: {},
    });
    logger.info({ locationId, phone }, 'Opt-out received; phone suppressed');
    // TODO(ghl): stop the contact's active iMessage workflow / campaign in GHL.
  }

  // Add the reply to GHL Conversations and update the contact's tags after the provider gets its response.
  // Our row is already saved, so a GHL failure never loses the reply. Unlinked phones have no location to sync to.
  if (locationId !== UNKNOWN) runInBackground('ghl-inbound-sync', () => syncInboundToGhl(messageId, { optOut }));

  // TODO(ghl): fire the "iMessage Received" workflow trigger for this contact (custom workflow trigger).

  return 'saved';
}

const OPT_OUT_PHRASES = new Set([
  'stop',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'remove me',
  "don't message me",
  'do not message me',
]);

/**
 * Whole-message match after trimming and lowercasing. Also tolerates surrounding punctuation,
 * curly apostrophes and repeated spaces ("STOP!", "Don’t message me.") so obvious opt-outs aren't missed.
 */
export function isOptOut(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.!?,;:"]+|[\s.!?,;:"]+$/g, '');
  return OPT_OUT_PHRASES.has(normalized);
}
