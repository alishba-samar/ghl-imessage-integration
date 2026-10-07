import { z } from 'zod';
import type { MessageStatus } from '../generated/prisma/client';
import type { DeliveryService } from '../providers';
import { getGhlClient } from './ghlClient';
import { GhlError } from './http';

// Docs (v3):
//   GET  /contacts/search/duplicate      https://marketplace.gohighlevel.com/docs/ghl/contacts/get-duplicate-contact
//   POST /contacts/upsert                https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact
//   POST /conversations/messages/inbound https://marketplace.gohighlevel.com/docs/ghl/conversations/add-an-inbound-message
//   PUT  /conversations/messages/:messageId/status
//                                        https://marketplace.gohighlevel.com/docs/ghl/conversations/update-message-status
// Our iMessage channel is a custom conversation provider ("Add new conversation channel"); conversationProviderId is
// required. The ConversationProviders guide says inbound messages for such a channel use type "SMS", but the live API
// rejects that ("Incorrect conversationProviderId/type", 2026-10-07) and accepts type "Custom" (stored as
// TYPE_CUSTOM_PROVIDER_SMS in the same conversation as our outbound TYPE_CUSTOM_SMS messages).

/** Statuses GHL accepts on Update message status. */
export type GhlMessageStatus = 'pending' | 'delivered' | 'read' | 'failed';

// The duplicate-search response schema isn't documented; accept { contact: { id } } and tolerate null.
const duplicateContactSchema = z.object({ contact: z.object({ id: z.string() }).nullish() }).passthrough();
const upsertContactSchema = z.object({ new: z.boolean().optional(), contact: z.object({ id: z.string() }) }).passthrough();
const inboundMessageSchema = z.object({ conversationId: z.string(), messageId: z.string() }).passthrough();

/** Returns the GHL contact id for a phone (E.164) in a location, creating the contact if none exists. */
export async function findOrCreateContactByPhone(locationId: string, phone: string): Promise<string> {
  const client = await getGhlClient(locationId);

  const found = duplicateContactSchema.safeParse(
    await client.request('GET', '/contacts/search/duplicate', { query: { locationId, number: phone } }),
  );
  if (found.success && found.data.contact?.id) return found.data.contact.id;

  // Upsert follows the location's duplicate-contact settings, so it updates a match instead of duplicating.
  const upserted = upsertContactSchema.safeParse(
    await client.request('POST', '/contacts/upsert', { body: { locationId, phone, source: 'iMessage integration' } }),
  );
  if (!upserted.success) {
    throw new GhlError('API_ERROR', 'GHL upsert contact response had no contact id', { path: '/contacts/upsert', locationId });
  }
  return upserted.data.contact.id;
}

export interface AddInboundMessageInput {
  contactId: string;
  conversationProviderId: string;
  message: string;
  attachments?: string[];
  /** Our provider's message id (e.g. Sendblue message_handle), stored by GHL as the external id. */
  altId: string;
  date: Date;
}

/** Adds an inbound message to the contact's GHL conversation. Returns GHL's conversation and message ids. */
export async function addInboundMessage(
  locationId: string,
  input: AddInboundMessageInput,
): Promise<{ conversationId: string; messageId: string }> {
  const client = await getGhlClient(locationId);
  const body = await client.request('POST', '/conversations/messages/inbound', {
    body: {
      type: 'Custom',
      conversationProviderId: input.conversationProviderId,
      contactId: input.contactId,
      message: input.message,
      attachments: input.attachments?.length ? input.attachments : undefined,
      altId: input.altId,
      // Documented default is "outbound" even on this endpoint, so set it explicitly.
      direction: 'inbound',
      date: input.date.toISOString(),
    },
  });
  const parsed = inboundMessageSchema.safeParse(body);
  if (!parsed.success) {
    throw new GhlError('API_ERROR', 'GHL inbound message response had no messageId/conversationId', {
      path: '/conversations/messages/inbound',
      locationId,
    });
  }
  return { conversationId: parsed.data.conversationId, messageId: parsed.data.messageId };
}

/**
 * Updates the status of a message GHL sent through our provider. Only the conversation provider's own
 * app token may do this (per the Conversation Providers docs).
 */
export async function updateMessageStatus(
  locationId: string,
  ghlMessageId: string,
  status: GhlMessageStatus,
  error?: { code?: string; message?: string },
): Promise<void> {
  const client = await getGhlClient(locationId);
  await client.request('PUT', `/conversations/messages/${encodeURIComponent(ghlMessageId)}/status`, {
    body: {
      status,
      error: status === 'failed' && error ? { code: error.code, message: error.message } : undefined,
    },
  });
}

/**
 * Maps our status to GHL's. GHL has no "sent" status: Sendblue reports SENT as final for SMS (DELIVERED is
 * only reported for iMessage/RCS), so SENT over SMS counts as delivered; SENT over iMessage stays pending
 * until DELIVERED arrives. Returns null when there is nothing to tell GHL.
 */
export function toGhlStatus(status: MessageStatus, service?: DeliveryService | string | null): GhlMessageStatus | null {
  switch (status) {
    case 'QUEUED':
      return 'pending';
    case 'SENT':
      return service === 'sms' ? 'delivered' : null;
    case 'DELIVERED':
      return 'delivered';
    case 'READ':
      return 'read';
    case 'FAILED':
      return 'failed';
  }
}

// Tags: POST / DELETE /contacts/:contactId/tags with { tags: string[] }
//   https://marketplace.gohighlevel.com/docs/ghl/contacts/add-tags
//   https://marketplace.gohighlevel.com/docs/ghl/contacts/remove-tags

export async function addContactTags(locationId: string, contactId: string, tags: string[]): Promise<void> {
  const client = await getGhlClient(locationId);
  await client.request('POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { body: { tags } });
}

export async function removeContactTags(locationId: string, contactId: string, tags: string[]): Promise<void> {
  const client = await getGhlClient(locationId);
  await client.request('DELETE', `/contacts/${encodeURIComponent(contactId)}/tags`, { body: { tags } });
}

// Send a new message: POST /conversations/messages
//   https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message
// With our conversationProviderId, GHL records the message in the contact's conversation and calls our
// Delivery URL (Provider Outbound Message webhook) to actually send it.
const sendMessageSchema = z.object({ messageId: z.string(), conversationId: z.string() }).passthrough();

export async function sendMessageViaProvider(
  locationId: string,
  input: { contactId: string; conversationProviderId: string; message: string; attachments?: string[]; toNumber: string },
): Promise<{ messageId: string; conversationId: string }> {
  const client = await getGhlClient(locationId);
  const body = await client.request('POST', '/conversations/messages', {
    body: {
      type: 'SMS',
      contactId: input.contactId,
      conversationProviderId: input.conversationProviderId,
      message: input.message,
      attachments: input.attachments?.length ? input.attachments : undefined,
      toNumber: input.toNumber,
      // Documented as required; "pending" = not sent yet (our Delivery URL sends it and reports the status).
      status: 'pending',
    },
  });
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    throw new GhlError('API_ERROR', 'GHL send message response had no messageId/conversationId', {
      path: '/conversations/messages',
      locationId,
    });
  }
  return { messageId: parsed.data.messageId, conversationId: parsed.data.conversationId };
}
