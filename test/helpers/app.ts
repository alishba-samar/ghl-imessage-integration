import { sign } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/db';
import { saveTokens } from '../../src/ghl/ghlClient';
import { getProvider } from '../../src/providers';
import { drainBackgroundTasks } from '../../src/utils/background';

export const app = createApp();
export const api = () => request(app);
export { prisma };

export const API_KEY = process.env.INTERNAL_API_KEY!;
export const SB_SECRET = process.env.SENDBLUE_WEBHOOK_SECRET!;
export const LOC = 'loc-1';

/** Waits for work the app runs after responding (GHL syncs, Delivery URL sends). */
export const settle = () => drainBackgroundTasks();

/** Counts real provider sends (mock provider) for the current test. */
export function spyProviderSends() {
  return vi.spyOn(getProvider(), 'sendMessage');
}

/** An installed location with valid (encrypted) tokens and a conversation provider id. */
export async function seedIntegration(locationId = LOC, opts: { conversationProviderId?: string | null; expiresInMs?: number } = {}) {
  await saveTokens(locationId, {
    accessToken: 'seed-access-token',
    refreshToken: 'seed-refresh-token',
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 86_400_000)),
  });
  const conversationProviderId = opts.conversationProviderId === undefined ? 'test-provider-id' : opts.conversationProviderId;
  await prisma.integration.update({ where: { locationId }, data: { conversationProviderId } });
}

export function sendMessage(body: object, key: string | null = API_KEY) {
  const req = api().post('/api/imessage/send');
  if (key !== null) req.set('x-api-key', key);
  return req.send(body);
}

export function sendblueWebhook(path: 'status' | 'inbound', body: object, secret: string | null = SB_SECRET) {
  const req = api().post(`/webhooks/imessage/${path}`);
  if (secret !== null) req.set('sb-signing-secret', secret);
  return req.send(body);
}

/** Signs a payload like GHL does: base64 Ed25519 over the raw JSON bytes (X-GHL-Signature). */
export function signGhl(raw: string, privateKeyPem = process.env.TEST_GHL_PRIVATE_KEY!): string {
  return sign(null, Buffer.from(raw), privateKeyPem).toString('base64');
}

/** POSTs a GHL Conversation Provider outbound payload to our Delivery URL. */
export function deliverFromGhl(payload: object, opts: { signature?: string | null; rawOverride?: string } = {}) {
  const raw = JSON.stringify(payload);
  const req = api().post('/webhooks/ghl/outbound-imessage').set('Content-Type', 'application/json');
  const signature = opts.signature === undefined ? signGhl(raw) : opts.signature;
  if (signature !== null) req.set('X-GHL-Signature', signature);
  return req.send(opts.rawOverride ?? raw);
}

export function ghlOutboundPayload(messageId: string, extra: object = {}) {
  return {
    contactId: 'contact-0101',
    locationId: LOC,
    messageId,
    type: 'SMS',
    phone: '+14155550101',
    message: 'Hello from GHL',
    attachments: [],
    userId: 'user-1',
    ...extra,
  };
}
