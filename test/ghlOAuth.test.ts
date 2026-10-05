import { HttpResponse, delay } from 'msw';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { getGhlClient } from '../src/ghl/ghlClient';
import { GhlError } from '../src/ghl/http';
import { decryptSecret } from '../src/utils/crypto';
import { LOC, api, prisma, seedIntegration } from './helpers/app';
import { ghl } from './helpers/ghl';

const TOKEN = /^\/oauth\/token$/;

describe('GET /oauth/callback', () => {
  it('exchanges the code and stores encrypted tokens', async () => {
    const res = await api().get('/oauth/callback?code=CODE-1');

    expect(res.status).toBe(200);
    expect(res.text).toContain('App installed');

    const [call] = ghl.callsTo('POST', TOKEN);
    expect(call.contentType).toContain('application/x-www-form-urlencoded');
    expect(call.version).toBe('v3');
    expect(call.authorization).toBeNull();
    expect(call.body).toMatchObject({
      client_id: 'test-ghl-client-id',
      client_secret: 'test-ghl-client-secret',
      grant_type: 'authorization_code',
      code: 'CODE-1',
      user_type: 'Location',
      redirect_uri: 'https://test.example/oauth/callback',
    });

    const integration = await prisma.integration.findUniqueOrThrow({ where: { locationId: LOC } });
    expect(integration.ghlAccessToken).toMatch(/^v1:/);
    expect(integration.ghlRefreshToken).toMatch(/^v1:/);
    expect(integration.ghlAccessToken).not.toContain('access-');
    expect(decryptSecret(integration.ghlAccessToken)).toMatch(/^access-\d+$/);
    expect(decryptSecret(integration.ghlRefreshToken)).toMatch(/^refresh-\d+$/);
    expect(integration.conversationProviderId).toBe('test-provider-id');
    expect(integration.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('sends GHL_OAUTH_REDIRECT_URI as redirect_uri on code exchange and refresh when it is set', async () => {
    const original = env.GHL_OAUTH_REDIRECT_URI;
    env.GHL_OAUTH_REDIRECT_URI = 'https://example.com/oauth/callback';
    try {
      expect((await api().get('/oauth/callback?code=CODE-2')).status).toBe(200);
      await prisma.integration.update({ where: { locationId: LOC }, data: { tokenExpiresAt: new Date(Date.now() + 60_000) } });
      await getGhlClient(LOC);

      const [exchange, refresh] = ghl.callsTo('POST', TOKEN);
      expect(exchange.body).toMatchObject({ grant_type: 'authorization_code', redirect_uri: 'https://example.com/oauth/callback' });
      expect(refresh.body).toMatchObject({ grant_type: 'refresh_token', redirect_uri: 'https://example.com/oauth/callback' });
    } finally {
      env.GHL_OAUTH_REDIRECT_URI = original;
    }
  });

  it('returns 400 without a code, 502 when GHL rejects it, 400 for an agency token', async () => {
    expect((await api().get('/oauth/callback')).status).toBe(400);

    ghl.on('POST', TOKEN, () => HttpResponse.json({ error: 'invalid_grant', error_description: 'bad code' }, { status: 400 }));
    expect((await api().get('/oauth/callback?code=BAD')).status).toBe(502);

    ghl.reset();
    ghl.on('POST', TOKEN, () =>
      HttpResponse.json({ access_token: 'a', refresh_token: 'r', expires_in: 86399, userType: 'Company', companyId: 'c' }),
    );
    expect((await api().get('/oauth/callback?code=AGENCY')).status).toBe(400);
    expect(await prisma.integration.count()).toBe(0);
  });
});

describe('getGhlClient token refresh', () => {
  it('does not refresh a token that is valid for more than 5 minutes', async () => {
    await seedIntegration();
    await getGhlClient(LOC);
    expect(ghl.callsTo('POST', TOKEN)).toHaveLength(0);
  });

  it('refreshes once for concurrent callers when the token expires within 5 minutes', async () => {
    await seedIntegration(LOC, { expiresInMs: 2 * 60_000 });
    ghl.on('POST', TOKEN, async () => {
      await delay(300);
      return HttpResponse.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 86399, userType: 'Location', locationId: LOC });
    });

    const clients = await Promise.all(Array.from({ length: 5 }, () => getGhlClient(LOC)));

    const refreshes = ghl.callsTo('POST', TOKEN);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'seed-refresh-token', user_type: 'Location' });

    const integration = await prisma.integration.findUniqueOrThrow({ where: { locationId: LOC } });
    expect(decryptSecret(integration.ghlAccessToken)).toBe('access-new');
    expect(decryptSecret(integration.ghlRefreshToken)).toBe('refresh-new');

    await clients[0].request('GET', '/contacts/contact-1');
    const apiCall = ghl.callsTo('GET', /^\/contacts\/contact-1$/)[0];
    expect(apiCall.authorization).toBe('Bearer access-new');
    expect(apiCall.version).toBe('v3');
  });

  it('fails with REFRESH_FAILED and keeps the stored tokens when GHL rejects the refresh', async () => {
    await seedIntegration(LOC, { expiresInMs: 60_000 });
    const before = await prisma.integration.findUniqueOrThrow({ where: { locationId: LOC } });
    ghl.on('POST', TOKEN, () => HttpResponse.json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, { status: 401 }));

    const err = await getGhlClient(LOC).catch((e) => e);
    expect(err).toBeInstanceOf(GhlError);
    expect(err).toMatchObject({ code: 'REFRESH_FAILED', details: { httpStatus: 401 } });

    const after = await prisma.integration.findUniqueOrThrow({ where: { locationId: LOC } });
    expect(after.ghlAccessToken).toBe(before.ghlAccessToken);
    expect(after.ghlRefreshToken).toBe(before.ghlRefreshToken);
  });

  it('fails with NOT_INSTALLED for an unknown location', async () => {
    await expect(getGhlClient('no-such-location')).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });
});
