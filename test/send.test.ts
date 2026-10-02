import { describe, expect, it } from 'vitest';
import { LOC, prisma, sendMessage, spyProviderSends } from './helpers/app';

const body = (extra: object = {}) => ({
  locationId: LOC,
  contactId: 'contact-1',
  phone: '(415) 555-0101',
  message: 'Hello from the test suite',
  ...extra,
});

describe('POST /api/imessage/send', () => {
  it('sends a message and records the result', async () => {
    const sends = spyProviderSends();
    const res = await sendMessage(body({ idempotencyKey: 'k-normal' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'SENT',
      direction: 'OUTBOUND',
      phone: '+14155550101',
      service: 'imessage',
      wasDowngraded: false,
      idempotencyKey: 'k-normal',
    });
    expect(res.body.providerMessageId).toMatch(/^mock_/);
    expect(res.body.sentAt).not.toBeNull();
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid phone with 400 and sends nothing', async () => {
    const sends = spyProviderSends();
    const res = await sendMessage(body({ phone: '123' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PHONE');
    expect(sends).not.toHaveBeenCalled();
    expect(await prisma.message.count()).toBe(0);
  });

  it('rejects missing fields with 400', async () => {
    const res = await sendMessage({ locationId: LOC, contactId: 'c', phone: '4155550101' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 409 for a suppressed phone and creates no message', async () => {
    await prisma.suppression.create({ data: { locationId: LOC, phone: '+14155550101', reason: 'STOP' } });
    const sends = spyProviderSends();
    const res = await sendMessage(body());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SUPPRESSED');
    expect(sends).not.toHaveBeenCalled();
    expect(await prisma.message.count()).toBe(0);
  });

  it('records a provider failure as FAILED', async () => {
    const res = await sendMessage(body({ message: 'please FAIL this one' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'FAILED', errorCode: 'MOCK_FAILURE' });
    expect(res.body.failedAt).not.toBeNull();
    expect(res.body.sentAt).toBeNull();
  });

  it('does not send twice for the same idempotency key', async () => {
    const sends = spyProviderSends();
    const first = await sendMessage(body({ idempotencyKey: 'k-dup' }));
    const second = await sendMessage(body({ idempotencyKey: 'k-dup', message: 'different text' }));

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(sends).toHaveBeenCalledTimes(1);
    expect(await prisma.message.count({ where: { idempotencyKey: 'k-dup' } })).toBe(1);
  });

  it('creates one row and one send for concurrent identical requests', async () => {
    const sends = spyProviderSends();
    const results = await Promise.all(Array.from({ length: 5 }, () => sendMessage(body({ idempotencyKey: 'k-race' }))));

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(await prisma.message.count({ where: { idempotencyKey: 'k-race' } })).toBe(1);
  });

  it('rejects a wrong or missing API key with 401', async () => {
    const sends = spyProviderSends();
    expect((await sendMessage(body(), 'wrong-key-wrong-key')).status).toBe(401);
    expect((await sendMessage(body(), null)).status).toBe(401);
    expect(sends).not.toHaveBeenCalled();
  });
});
