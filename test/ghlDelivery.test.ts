import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LOC, deliverFromGhl, ghlOutboundPayload, prisma, seedIntegration, sendblueWebhook, settle, signGhl, spyProviderSends } from './helpers/app';
import { ghl } from './helpers/ghl';

const STATUS = /^\/conversations\/messages\/[^/]+\/status$/;

describe('POST /webhooks/ghl/outbound-imessage (Delivery URL)', () => {
  it('sends a correctly signed message once and stores the GHL message id', async () => {
    await seedIntegration();
    const sends = spyProviderSends();

    const res = await deliverFromGhl(ghlOutboundPayload('ghl-out-1'));
    expect(res.status).toBe(200);
    await settle();

    expect(sends).toHaveBeenCalledTimes(1);
    expect(sends.mock.calls[0][0]).toMatchObject({ to: '+14155550101', content: 'Hello from GHL' });
    const row = await prisma.message.findUniqueOrThrow({ where: { ghlMessageId: 'ghl-out-1' } });
    expect(row).toMatchObject({ idempotencyKey: 'ghl-out-1', status: 'SENT', contactId: 'contact-0101' });
  });

  it('rejects a tampered body, a wrong key and a missing signature with 401', async () => {
    await seedIntegration();
    const sends = spyProviderSends();
    const payload = ghlOutboundPayload('ghl-out-bad');
    const raw = JSON.stringify(payload);
    const { privateKey: otherKey } = generateKeyPairSync('ed25519');

    const tampered = await deliverFromGhl(payload, { signature: signGhl(raw), rawOverride: raw.replace('Hello', 'Hijacked') });
    const wrongKey = await deliverFromGhl(payload, { signature: signGhl(raw, otherKey.export({ type: 'pkcs8', format: 'pem' }).toString()) });
    const missing = await deliverFromGhl(payload, { signature: null });
    await settle();

    expect([tampered.status, wrongKey.status, missing.status]).toEqual([401, 401, 401]);
    expect(sends).not.toHaveBeenCalled();
    expect(await prisma.message.count()).toBe(0);
  });

  it('does not send again when GHL delivers the same messageId twice', async () => {
    await seedIntegration();
    const sends = spyProviderSends();

    await deliverFromGhl(ghlOutboundPayload('ghl-out-dup'));
    await settle();
    await Promise.all([deliverFromGhl(ghlOutboundPayload('ghl-out-dup')), deliverFromGhl(ghlOutboundPayload('ghl-out-dup'))]);
    await settle();

    expect(sends).toHaveBeenCalledTimes(1);
    expect(await prisma.message.count({ where: { ghlMessageId: 'ghl-out-dup' } })).toBe(1);
  });

  it('marks the GHL message failed when the provider fails or the phone is suppressed', async () => {
    await seedIntegration();
    await deliverFromGhl(ghlOutboundPayload('ghl-out-fail', { message: 'please FAIL' }));
    await prisma.suppression.create({ data: { locationId: LOC, phone: '+14155550102', reason: 'STOP' } });
    await deliverFromGhl(ghlOutboundPayload('ghl-out-supp', { phone: '+14155550102' }));
    await settle();

    const statuses = ghl.callsTo('PUT', STATUS).map((c) => [c.path.split('/')[3], c.body.status, c.body.error?.code]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        ['ghl-out-fail', 'failed', 'MOCK_FAILURE'],
        ['ghl-out-supp', 'failed', 'SUPPRESSED'],
      ]),
    );
  });

  it('syncs provider status updates back to GHL', async () => {
    await seedIntegration();
    await deliverFromGhl(ghlOutboundPayload('ghl-out-status'));
    await settle();
    const row = await prisma.message.findUniqueOrThrow({ where: { ghlMessageId: 'ghl-out-status' } });

    await sendblueWebhook('status', { id: row.providerMessageId, status: 'DELIVERED', service: 'imessage' });
    await settle();

    const update = ghl.callsTo('PUT', STATUS).find((c) => c.path.includes('ghl-out-status'));
    expect(update?.body).toEqual({ status: 'delivered' });
    expect(update?.version).toBe('v3');
  });

  it('keeps our status update when GHL fails to accept it', async () => {
    await seedIntegration();
    await deliverFromGhl(ghlOutboundPayload('ghl-out-ghl-down'));
    await settle();
    const row = await prisma.message.findUniqueOrThrow({ where: { ghlMessageId: 'ghl-out-ghl-down' } });
    ghl.fail('PUT', STATUS, 503);

    const res = await sendblueWebhook('status', { id: row.providerMessageId, status: 'DELIVERED' });
    await settle();

    expect(res.status).toBe(200);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('DELIVERED');
  });
});
