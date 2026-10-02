import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_KEY, LOC, api, deliverFromGhl, prisma, seedIntegration, settle, spyProviderSends } from './helpers/app';
import { ghl, type GhlCall } from './helpers/ghl';

const SEND = /^\/conversations\/messages$/;
let msgCounter = 0;

/** Makes GHL's Send Message API behave like GHL: respond, and call our Delivery URL before or after responding. */
function ghlDeliversVia(mode: 'after' | 'before' | 'twice' | 'never') {
  const deliveries: Promise<unknown>[] = [];
  ghl.on('POST', SEND, async (call: GhlCall) => {
    const messageId = `ghl-wf-${++msgCounter}`;
    const payload = { contactId: call.body.contactId, locationId: LOC, messageId, type: 'SMS', phone: call.body.toNumber, message: call.body.message, attachments: [] };
    if (mode === 'before') {
      await deliverFromGhl(payload);
      await settle(); // our Delivery handler fully sends before GHL's API response reaches us
    } else if (mode !== 'never') {
      const later = (ms: number) => new Promise((r) => setTimeout(r, ms)).then(() => deliverFromGhl(payload));
      deliveries.push(later(30));
      if (mode === 'twice') deliveries.push(later(80));
    }
    return HttpResponse.json({ conversationId: 'conv-1', messageId });
  });
  return { done: async () => { await Promise.all(deliveries); await settle(); } };
}

function workflowSend(extra: object = {}, key: string | null = API_KEY) {
  const req = api().post('/api/ghl/workflow/send-imessage');
  if (key !== null) req.set('x-api-key', key);
  // GHL merge fields arrive as strings.
  return req.send({ locationId: LOC, contactId: 'contact-0131', phone: '(415) 555-0131', message: 'Spring offer', campaignId: 'spring', campaignStep: '1', ...extra });
}
const stepKey = (step: number) => `${LOC}-contact-0131-spring-${step}`;

describe('POST /api/ghl/workflow/send-imessage', () => {
  it('sends through GHL Conversations and delivers once via the Delivery URL', async () => {
    await seedIntegration();
    const sends = spyProviderSends();
    const ghlFlow = ghlDeliversVia('after');

    const res = await workflowSend();
    await ghlFlow.done();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: false, ghlMessageId: expect.stringMatching(/^ghl-wf-/) });
    expect(ghl.callsTo('POST', SEND)[0].body).toEqual({
      type: 'SMS',
      contactId: 'contact-0131',
      conversationProviderId: 'test-provider-id',
      message: 'Spring offer',
      toNumber: '+14155550131',
      status: 'pending',
    });
    expect(sends).toHaveBeenCalledTimes(1);
    const rows = await prisma.message.findMany({ where: { idempotencyKey: stepKey(1) } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SENT', ghlMessageId: res.body.ghlMessageId, conversationId: 'conv-1', campaignStep: 1 });
  });

  it('does not call GHL or send again for the same campaign step', async () => {
    await seedIntegration();
    const sends = spyProviderSends();
    const ghlFlow = ghlDeliversVia('after');

    const first = await workflowSend();
    await ghlFlow.done();
    const again = await workflowSend({ message: 'retry text' });
    await ghlFlow.done();

    expect(again.body).toMatchObject({ duplicate: true, messageId: first.body.messageId });
    expect(ghl.callsTo('POST', SEND)).toHaveLength(1);
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it('handles the race where the Delivery arrives before GHL responds (one row, one send)', async () => {
    await seedIntegration();
    const sends = spyProviderSends();
    ghlDeliversVia('before');

    const res = await workflowSend({ campaignStep: '2' });
    await settle();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sends).toHaveBeenCalledTimes(1);
    const rows = await prisma.message.findMany({ where: { locationId: LOC } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idempotencyKey: stepKey(2), ghlMessageId: res.body.ghlMessageId, campaignStep: 2, status: 'SENT' });
  });

  it('sends once when GHL calls the Delivery URL twice', async () => {
    await seedIntegration();
    const sends = spyProviderSends();
    const ghlFlow = ghlDeliversVia('twice');

    await workflowSend({ campaignStep: '3' });
    await ghlFlow.done();

    expect(sends).toHaveBeenCalledTimes(1);
    expect(await prisma.message.count()).toBe(1);
  });

  it('makes one GHL call and one send for concurrent identical workflow calls', async () => {
    await seedIntegration();
    const sends = spyProviderSends();
    const ghlFlow = ghlDeliversVia('after');

    const results = await Promise.all(Array.from({ length: 5 }, () => workflowSend({ campaignStep: '4' })));
    await ghlFlow.done();

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.filter((r) => r.body.duplicate)).toHaveLength(4);
    expect(ghl.callsTo('POST', SEND)).toHaveLength(1);
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it('does not send when the GHL Send Message API fails, and does not retry the step', async () => {
    await seedIntegration();
    const sends = spyProviderSends();
    ghl.fail('POST', SEND, 500);

    const res = await workflowSend({ campaignStep: '5' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, error: 'GHL_SEND_FAILED' });

    const retry = await workflowSend({ campaignStep: '5' });
    expect(retry.body).toMatchObject({ duplicate: true, status: 'FAILED', errorCode: 'GHL_SEND_FAILED' });
    expect(ghl.callsTo('POST', SEND)).toHaveLength(1);
    expect(sends).not.toHaveBeenCalled();
  });

  it('does not send when the contact opts out before GHL delivers', async () => {
    await seedIntegration();
    const sends = spyProviderSends();
    ghlDeliversVia('never');

    const res = await workflowSend({ campaignStep: '6' });
    await prisma.suppression.create({ data: { locationId: LOC, phone: '+14155550131', reason: 'STOP' } });
    await deliverFromGhl({ contactId: 'contact-0131', locationId: LOC, messageId: res.body.ghlMessageId, type: 'SMS', phone: '+14155550131', message: 'Spring offer' });
    await settle();

    expect(sends).not.toHaveBeenCalled();
    expect(await prisma.message.findUniqueOrThrow({ where: { ghlMessageId: res.body.ghlMessageId } })).toMatchObject({ status: 'FAILED', errorCode: 'SUPPRESSED' });
  });

  it('returns 401 for a bad key, 400 for invalid input, 200 + error for suppressed / not connected', async () => {
    await seedIntegration(LOC, { conversationProviderId: null });
    await prisma.suppression.create({ data: { locationId: LOC, phone: '+14155550132', reason: 'STOP' } });

    expect((await workflowSend({}, 'wrong-key-wrong-key')).status).toBe(401);
    expect((await workflowSend({}, null)).status).toBe(401);
    expect((await workflowSend({ phone: '' })).status).toBe(400); // unset {{contact.phone}} merge field
    expect((await workflowSend({ phone: '123' })).body).toMatchObject({ error: 'INVALID_PHONE' });
    expect((await workflowSend({ phone: '+14155550132' })).body).toMatchObject({ ok: false, error: 'SUPPRESSED' });
    const notConnected = await workflowSend();
    expect(notConnected.status).toBe(200);
    expect(notConnected.body).toMatchObject({ ok: false, error: 'GHL_NOT_CONNECTED' });
    expect(ghl.callsTo('POST', SEND)).toHaveLength(0);
  });
});
