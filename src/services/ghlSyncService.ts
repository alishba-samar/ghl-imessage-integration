import { prisma } from '../config/db';
import {
  addContactTags,
  addInboundMessage,
  findOrCreateContactByPhone,
  removeContactTags,
  toGhlStatus,
  updateMessageStatus,
} from '../ghl/conversations';
import { GhlError } from '../ghl/http';
import { logger } from '../utils/logger';

// Pushes our message events to GHL Conversations. These run in the background after a webhook is
// acknowledged; GHL failures are logged and never undo or block our own records.

export const TAG_REPLIED = 'imessage-replied';
export const TAG_CAMPAIGN_ACTIVE = 'imessage-campaign-active';
export const TAG_OPTOUT = 'imessage-optout';

/**
 * For a saved INBOUND message: adds it to GHL Conversations (if the location has a conversation provider
 * id), stores GHL's ids on our row, then tags the contact: +imessage-replied, -imessage-campaign-active,
 * and +imessage-optout for opt-outs. Each GHL call fails independently; failures are logged and our
 * row is never affected.
 */
export async function syncInboundToGhl(messageId: string, opts: { optOut?: boolean } = {}): Promise<void> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.direction !== 'INBOUND') return;

  const integration = await prisma.integration.findUnique({ where: { locationId: message.locationId } });
  if (!integration) {
    logger.debug({ messageId, locationId: message.locationId }, 'Location has no GHL integration; inbound not synced');
    return;
  }
  if (!message.phone) {
    logger.warn({ messageId }, 'Inbound message has no phone; cannot sync to GHL');
    return;
  }
  const ctx = { messageId, locationId: message.locationId };

  let contactId: string;
  try {
    contactId = await findOrCreateContactByPhone(message.locationId, message.phone);
  } catch (err) {
    logGhlFailure(err, 'Failed to find/create GHL contact for inbound message (kept locally)', ctx);
    return;
  }

  if (!integration.conversationProviderId) {
    logger.warn(ctx, 'No conversationProviderId for location; inbound message not added to GHL');
  } else if (!message.ghlMessageId) {
    try {
      const ghl = await addInboundMessage(message.locationId, {
        contactId,
        conversationProviderId: integration.conversationProviderId,
        message: message.body,
        attachments: message.mediaUrl ? [message.mediaUrl] : undefined,
        altId: message.providerMessageId ?? message.id,
        date: message.deliveredAt ?? message.createdAt,
      });
      await prisma.message.update({
        where: { id: message.id },
        data: { ghlMessageId: ghl.messageId, conversationId: ghl.conversationId },
      });
      logger.info({ ...ctx, ghlMessageId: ghl.messageId, conversationId: ghl.conversationId }, 'Inbound message added to GHL');
    } catch (err) {
      logGhlFailure(err, 'Failed to add inbound message to GHL (kept locally)', ctx);
    }
  }

  const addTags = opts.optOut ? [TAG_REPLIED, TAG_OPTOUT] : [TAG_REPLIED];
  try {
    await addContactTags(message.locationId, contactId, addTags);
    logger.info({ ...ctx, contactId, tags: addTags }, 'GHL contact tags added');
  } catch (err) {
    logGhlFailure(err, 'Failed to add GHL contact tags', { ...ctx, contactId, tags: addTags });
  }
  try {
    await removeContactTags(message.locationId, contactId, [TAG_CAMPAIGN_ACTIVE]);
    logger.info({ ...ctx, contactId, tags: [TAG_CAMPAIGN_ACTIVE] }, 'GHL contact tags removed');
  } catch (err) {
    logGhlFailure(err, 'Failed to remove GHL contact tag', { ...ctx, contactId, tags: [TAG_CAMPAIGN_ACTIVE] });
  }
}

/** Sends a message's current status to GHL, if GHL originated it (has a ghlMessageId). */
export async function syncStatusToGhl(messageId: string): Promise<void> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message?.ghlMessageId || message.direction !== 'OUTBOUND') return;

  const status = toGhlStatus(message.status, message.service);
  if (!status) return;

  try {
    await updateMessageStatus(message.locationId, message.ghlMessageId, status, {
      code: message.errorCode ?? undefined,
      message: message.errorMessage ?? undefined,
    });
    logger.info({ messageId, ghlMessageId: message.ghlMessageId, status }, 'GHL message status updated');
  } catch (err) {
    logGhlFailure(err, 'Failed to update GHL message status', { messageId, locationId: message.locationId, status });
  }
}

/** Marks a GHL-originated message as failed when we never created a row for it (e.g. suppressed, invalid phone). */
export async function failGhlMessage(locationId: string, ghlMessageId: string, code: string, reason: string): Promise<void> {
  try {
    await updateMessageStatus(locationId, ghlMessageId, 'failed', { code, message: reason });
    logger.info({ locationId, ghlMessageId, code }, 'GHL message marked failed');
  } catch (err) {
    logGhlFailure(err, 'Failed to mark GHL message as failed', { locationId, ghlMessageId, code });
  }
}

function logGhlFailure(err: unknown, msg: string, context: Record<string, unknown>): void {
  if (err instanceof GhlError) {
    logger.error({ ...context, code: err.code, ...err.details, error: err.message }, msg);
  } else {
    logger.error({ ...context, err }, msg);
  }
}
