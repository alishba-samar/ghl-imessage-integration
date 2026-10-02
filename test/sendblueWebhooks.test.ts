import { describe, expect, it } from 'vitest';
import { LOC, prisma, sendMessage, sendblueWebhook } from './helpers/app';

// Payload shapes accepted by the mock provider's parsers (IMESSAGE_PROVIDER=mock).
const PHONE = '+14155550101';
const LINE = '+15550001111';

async function sendOne(extra: object = {}) {
  const res = await sendMessage({ locationId: LOC, contactId: 'contact-1', phone: PHONE, message: 'Hi there', ...extra });
  expect(res.status).toBe(200);
  return res.body as { id: string; providerMessageId: string };
}
const row = (id: string) => prisma.message.findUniqueOrThrow({ where: { id } });

describe('POST /webhooks/imessage/status', () => {
  it('applies a DELIVERED status', async () => {
    const msg = await sendOne();
    const res = await sendblueWebhook('status', { id: msg.providerMessageId, status: 'DELIVERED', service: 'imessage', wasDowngraded: false });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('updated');
    const r = await row(msg.id);
    expect(r).toMatchObject({ status: 'DELIVERED', service: 'imessage', wasDowngraded: false });
    expect(r.deliveredAt).not.toBeNull();
  });

  it('ignores a duplicate status webhook', async () => {
    const msg = await sendOne();
    await sendblueWebhook('status', { id: msg.providerMessageId, status: 'DELIVERED' });
    const before = await row(msg.id);
    const res = await sendblueWebhook('status', { id: msg.providerMessageId, status: 'DELIVERED' });

    expect(res.body.outcome).toBe('stale');
    expect(await row(msg.id)).toEqual(before);
  });

  it('never moves a status backwards (SENT or FAILED after DELIVERED)', async () => {
    const msg = await sendOne();
    await sendblueWebhook('status', { id: msg.providerMessageId, status: 'DELIVERED', service: 'imessage' });
    const before = await row(msg.id);

    expect((await sendblueWebhook('status', { id: msg.providerMessageId, status: 'SENT', service: 'sms' })).body.outcome).toBe('stale');
    expect((await sendblueWebhook('status', { id: msg.providerMessageId, status: 'FAILED', errorCode: 'LATE' })).body.outcome).toBe('stale');
    expect(await row(msg.id)).toEqual(before);
  });

  it('applies a FAILED status with error details', async () => {
    const msg = await sendOne();
    await sendblueWebhook('status', { id: msg.providerMessageId, status: 'FAILED', errorCode: '4002', errorMessage: 'Blacklisted', isPermanentFailure: true });

    const r = await row(msg.id);
    expect(r).toMatchObject({ status: 'FAILED', errorCode: '4002', errorMessage: 'Blacklisted' });
    expect(r.failedAt).not.toBeNull();
  });

  it('acknowledges in-progress, unknown and malformed payloads without changes', async () => {
    const msg = await sendOne();
    expect((await sendblueWebhook('status', { id: msg.providerMessageId, status: 'QUEUED' })).body.outcome).toBe('ignored');
    expect((await sendblueWebhook('status', { id: 'mock_unknown', status: 'DELIVERED' })).body.outcome).toBe('not_found');
    expect((await sendblueWebhook('status', { hello: 'world' })).body.outcome).toBe('ignored');
    expect((await row(msg.id)).status).toBe('SENT');
  });

  it('rejects a wrong or missing signing secret with 401', async () => {
    const msg = await sendOne();
    expect((await sendblueWebhook('status', { id: msg.providerMessageId, status: 'DELIVERED' }, 'wrong')).status).toBe(401);
    expect((await sendblueWebhook('status', { id: msg.providerMessageId, status: 'DELIVERED' }, null)).status).toBe(401);
    expect((await row(msg.id)).status).toBe('SENT');
  });
});

describe('POST /webhooks/imessage/inbound', () => {
  it('saves a reply linked to the earlier send', async () => {
    await sendOne();
    const res = await sendblueWebhook('inbound', { id: 'mock_in_1', from: '(415) 555-0101', to: LINE, content: 'Thanks!' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('saved');
    const reply = await prisma.message.findFirstOrThrow({ where: { providerMessageId: 'mock_in_1' } });
    expect(reply).toMatchObject({ direction: 'INBOUND', status: 'DELIVERED', locationId: LOC, contactId: 'contact-1', phone: PHONE, body: 'Thanks!' });
  });

  it('stores a reply from an unknown phone under "unknown"', async () => {
    await sendblueWebhook('inbound', { id: 'mock_in_unknown', from: '+14155550199', to: LINE, content: 'Who is this?' });
    const reply = await prisma.message.findFirstOrThrow({ where: { providerMessageId: 'mock_in_unknown' } });
    expect(reply).toMatchObject({ locationId: 'unknown', contactId: 'unknown' });
  });

  it('ignores a duplicate inbound webhook, including concurrent duplicates', async () => {
    await sendOne();
    await sendblueWebhook('inbound', { id: 'mock_in_dup', from: PHONE, to: LINE, content: 'Hi' });
    expect((await sendblueWebhook('inbound', { id: 'mock_in_dup', from: PHONE, to: LINE, content: 'Hi' })).body.outcome).toBe('duplicate');

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => sendblueWebhook('inbound', { id: 'mock_in_race', from: PHONE, to: LINE, content: 'race' })),
    );
    expect(outcomes.map((o) => o.body.outcome).sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'saved']);
    expect(await prisma.message.count({ where: { providerMessageId: { in: ['mock_in_dup', 'mock_in_race'] } } })).toBe(2);
  });

  it('suppresses the phone on STOP so the next send returns 409', async () => {
    await sendOne();
    await sendblueWebhook('inbound', { id: 'mock_in_stop', from: PHONE, to: LINE, content: '  STOP! ' });

    expect(await prisma.suppression.findUnique({ where: { locationId_phone: { locationId: LOC, phone: PHONE } } })).toMatchObject({
      reason: 'STOP',
      contactId: 'contact-1',
    });
    const next = await sendMessage({ locationId: LOC, contactId: 'contact-1', phone: PHONE, message: 'One more offer' });
    expect(next.status).toBe(409);
    expect(next.body.error).toBe('SUPPRESSED');
  });

  it('does not treat a sentence containing "stop" as an opt-out', async () => {
    await sendOne();
    await sendblueWebhook('inbound', { id: 'mock_in_sentence', from: PHONE, to: LINE, content: "Please don't stop sending these" });
    expect(await prisma.suppression.count()).toBe(0);
  });

  it('rejects a wrong or missing signing secret with 401', async () => {
    expect((await sendblueWebhook('inbound', { id: 'x', from: PHONE, to: LINE, content: 'hi' }, 'wrong')).status).toBe(401);
    expect((await sendblueWebhook('inbound', { id: 'x', from: PHONE, to: LINE, content: 'hi' }, null)).status).toBe(401);
    expect(await prisma.message.count()).toBe(0);
  });
});
