import { describe, expect, it } from 'vitest';
import { LOC, prisma, seedIntegration, sendMessage, sendblueWebhook, settle } from './helpers/app';
import { ghl } from './helpers/ghl';

const PHONE = '+14155550121';
const LINE = '+15550001111';
const TAGS = /^\/contacts\/[^/]+\/tags$/;
const INBOUND = /^\/conversations\/messages\/inbound$/;

async function replyFromContact(id: string, content: string) {
  await sendMessage({ locationId: LOC, contactId: 'contact-0121', phone: PHONE, message: 'Campaign message' });
  const res = await sendblueWebhook('inbound', { id, from: PHONE, to: LINE, content });
  await settle();
  expect(res.status).toBe(200);
  return prisma.message.findFirstOrThrow({ where: { providerMessageId: id } });
}
const tagCalls = () => ghl.callsTo('POST', TAGS).concat(ghl.callsTo('DELETE', TAGS)).map((c) => [c.method, c.path, c.body.tags]);

describe('inbound replies → GHL', () => {
  it('adds the reply to GHL Conversations, stores GHL ids and updates tags', async () => {
    await seedIntegration();
    const reply = await replyFromContact('mock_in_sync_1', 'Sounds good!');

    expect(ghl.callsTo('GET', /^\/contacts\/search\/duplicate$/)[0].query).toEqual({ locationId: LOC, number: PHONE });
    expect(ghl.callsTo('POST', INBOUND)[0].body).toMatchObject({
      type: 'Custom',
      conversationProviderId: 'test-provider-id',
      contactId: 'contact-0121',
      message: 'Sounds good!',
      altId: 'mock_in_sync_1',
      direction: 'inbound',
    });
    expect(reply.ghlMessageId).toMatch(/^ghl-in-/);
    expect(reply.conversationId).toBe('conv-1');
    expect(tagCalls()).toEqual([
      ['POST', '/contacts/contact-0121/tags', ['imessage-replied']],
      ['DELETE', '/contacts/contact-0121/tags', ['imessage-campaign-active']],
    ]);
  });

  it('adds the opt-out tag on STOP', async () => {
    await seedIntegration();
    await replyFromContact('mock_in_sync_stop', 'STOP');

    expect(tagCalls()).toEqual([
      ['POST', '/contacts/contact-0121/tags', ['imessage-replied', 'imessage-optout']],
      ['DELETE', '/contacts/contact-0121/tags', ['imessage-campaign-active']],
    ]);
    expect(await prisma.suppression.count({ where: { locationId: LOC, phone: PHONE } })).toBe(1);
  });

  it('keeps the reply when the GHL tag API fails', async () => {
    await seedIntegration();
    ghl.fail('POST', TAGS, 500);
    ghl.fail('DELETE', TAGS, 500);
    const reply = await replyFromContact('mock_in_sync_tagfail', 'Reply while tags are down');

    expect(reply).toMatchObject({ direction: 'INBOUND', status: 'DELIVERED', locationId: LOC });
    expect(reply.ghlMessageId).toMatch(/^ghl-in-/); // inbound sync still worked
  });

  it('keeps the reply (without GHL ids) when adding it to GHL fails', async () => {
    await seedIntegration();
    ghl.fail('POST', INBOUND, 500);
    const reply = await replyFromContact('mock_in_sync_ghlfail', 'Reply while GHL is down');

    expect(reply).toMatchObject({ direction: 'INBOUND', status: 'DELIVERED', body: 'Reply while GHL is down' });
    expect(reply.ghlMessageId).toBeNull();
    expect(ghl.callsTo('POST', INBOUND)).toHaveLength(1);
  });

  it('still tags the contact when the location has no conversation provider id', async () => {
    await seedIntegration(LOC, { conversationProviderId: null });
    const reply = await replyFromContact('mock_in_sync_noprov', 'Hello');

    expect(ghl.callsTo('POST', INBOUND)).toHaveLength(0);
    expect(reply.ghlMessageId).toBeNull();
    expect(tagCalls()).toHaveLength(2);
  });

  it('makes no GHL calls for a location that never installed the app', async () => {
    await replyFromContact('mock_in_sync_noinstall', 'Hello');
    expect(ghl.calls).toHaveLength(0);
  });
});
