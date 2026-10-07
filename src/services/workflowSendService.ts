import { randomUUID } from 'node:crypto';
import { isUniqueViolation, prisma } from '../config/db';
import type { Message } from '../generated/prisma/client';
import { getContactPhone, sendMessageViaProvider } from '../ghl/conversations';
import { GhlError } from '../ghl/http';
import { logger } from '../utils/logger';
import { normalizeToE164 } from '../utils/phone';
import { createOutboundRow } from './sendService';

export interface WorkflowSendInput {
  locationId: string;
  contactId: string;
  phone: string;
  message: string;
  campaignId?: string;
  campaignStep?: number;
}

export type WorkflowSendResult =
  | { ok: true; message: Message; duplicate: boolean }
  | { ok: false; error: 'INVALID_PHONE' | 'SUPPRESSED' | 'GHL_NOT_CONNECTED'; details: string }
  | { ok: false; error: 'GHL_SEND_FAILED'; details: string; message: Message };

/**
 * Sends a workflow message through GHL so it appears in GHL Conversations:
 *   1. Reserve the campaign step: create our QUEUED row (unique idempotencyKey). A repeat of the same
 *      step stops here, so GHL is called (and the message sent) at most once per step.
 *   2. Ask GHL to send it via our conversation provider (POST /conversations/messages). GHL records it and
 *      calls our Delivery URL, whose handler does the one provider send.
 *   3. Link GHL's messageId to the reserved row so the Delivery handler finds and dispatches it.
 * If GHL calls the Delivery URL before step 3, the handler creates its own row for that GHL messageId
 * and sends it; step 3 then hits the unique ghlMessageId and merges the reservation into that row.
 * Either way the provider send happens exactly once (dispatchMessage claims the row atomically).
 */
export async function sendViaGhlWorkflow(input: WorkflowSendInput): Promise<WorkflowSendResult> {
  // Without a "+" country code the number is in some country's national format; guessing a country could pick the
  // wrong person, so use the E.164 number GHL stores for the contact and only fall back to parsing the given text.
  const phone = input.phone.trim().startsWith('+')
    ? normalizeToE164(input.phone)
    : ((await phoneFromGhlContact(input.locationId, input.contactId)) ?? normalizeToE164(input.phone));
  if (!phone) return { ok: false, error: 'INVALID_PHONE', details: `Invalid phone number: ${input.phone}` };

  const suppression = await prisma.suppression.findUnique({
    where: { locationId_phone: { locationId: input.locationId, phone } },
  });
  if (suppression) return { ok: false, error: 'SUPPRESSED', details: `${phone} is suppressed (${suppression.reason})` };

  const integration = await prisma.integration.findUnique({ where: { locationId: input.locationId } });
  if (!integration?.conversationProviderId) {
    return {
      ok: false,
      error: 'GHL_NOT_CONNECTED',
      details: `Location ${input.locationId} has no GHL integration with a conversation provider`,
    };
  }

  // 1. Reserve
  const idempotencyKey =
    input.campaignId !== undefined && input.campaignStep !== undefined
      ? `${input.locationId}-${input.contactId}-${input.campaignId}-${input.campaignStep}`
      : `wf-${randomUUID()}`;
  let reserved: Message;
  try {
    reserved = await createOutboundRow({ ...input, phone, idempotencyKey });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await prisma.message.findUniqueOrThrow({ where: { idempotencyKey } });
    logger.info({ messageId: existing.id, idempotencyKey }, 'Workflow step already sent or in progress; not sending again');
    return { ok: true, message: existing, duplicate: true };
  }

  // 2. Send through GHL
  let ghl: { messageId: string; conversationId: string };
  try {
    ghl = await sendMessageViaProvider(input.locationId, {
      contactId: input.contactId,
      conversationProviderId: integration.conversationProviderId,
      message: input.message,
      toNumber: phone,
    });
  } catch (err) {
    const details = err instanceof GhlError ? err.message : String(err);
    logger.error(
      { messageId: reserved.id, ...(err instanceof GhlError ? { code: err.code, ...err.details } : { err }) },
      'GHL send message failed; workflow step not sent',
    );
    // Keep the reservation (as FAILED) so a retry can't double-send if GHL actually accepted the request.
    const failed = await prisma.message.update({
      where: { id: reserved.id },
      data: { status: 'FAILED', failedAt: new Date(), errorCode: 'GHL_SEND_FAILED', errorMessage: details },
    });
    return { ok: false, error: 'GHL_SEND_FAILED', details, message: failed };
  }

  // 3. Link GHL's message id (or merge if the Delivery handler already created a row for it)
  try {
    const linked = await prisma.message.update({
      where: { id: reserved.id },
      data: { ghlMessageId: ghl.messageId, conversationId: ghl.conversationId },
    });
    logger.info({ messageId: linked.id, ghlMessageId: ghl.messageId }, 'Workflow message sent via GHL');
    return { ok: true, message: linked, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const merged = await prisma.$transaction(async (tx) => {
      const delivered = await tx.message.findUniqueOrThrow({ where: { ghlMessageId: ghl.messageId } });
      await tx.message.delete({ where: { id: reserved.id } });
      return tx.message.update({
        where: { id: delivered.id },
        data: {
          idempotencyKey,
          campaignId: input.campaignId,
          campaignStep: input.campaignStep,
          conversationId: ghl.conversationId,
        },
      });
    });
    logger.info(
      { messageId: merged.id, ghlMessageId: ghl.messageId },
      'GHL Delivery arrived before the send response; merged the reservation into the delivered message',
    );
    return { ok: true, message: merged, duplicate: false };
  }
}

/**
 * GHL fills `{{contact.phone}}` in the location's national format (e.g. "0304 1234567" in Pakistan), which can't be
 * normalized reliably without knowing the country. The contact record in GHL stores the number in E.164.
 */
async function phoneFromGhlContact(locationId: string, contactId: string): Promise<string | null> {
  try {
    const stored = await getContactPhone(locationId, contactId);
    const phone = stored ? normalizeToE164(stored) : null;
    logger.info({ locationId, contactId, resolved: !!phone }, 'Workflow phone has no country code; looked up the GHL contact phone');
    return phone;
  } catch (err) {
    logger.warn(
      { locationId, contactId, ...(err instanceof GhlError ? { code: err.code, ...err.details } : { err }) },
      'Could not read the contact phone from GHL',
    );
    return null;
  }
}
