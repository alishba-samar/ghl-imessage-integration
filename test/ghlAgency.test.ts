import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { ghlAppId, saveCompanyTokens } from '../src/ghl/agency';
import { getGhlClient, saveTokens } from '../src/ghl/ghlClient';
import { decryptSecret } from '../src/utils/crypto';
import { api, prisma, signGhl } from './helpers/app';
import { ghl, type GhlCall } from './helpers/ghl';

const TOKEN = /^\/oauth\/token$/;
const INSTALLED = /^\/oauth\/installed-locations$/;
const LEGACY_INSTALLED = /^\/oauth\/installedLocations$/;
const LOCATION_TOKEN = /^\/oauth\/location-token$/;
const LEGACY_LOCATION_TOKEN = /^\/oauth\/locationToken$/;
const COMPANY = 'company-1';

/** The code exchange returns a Company token, as GHL does when an agency user installs the app. */
function agencyCodeExchange() {
  ghl.on('POST', TOKEN, (call: GhlCall) =>
    call.body.grant_type === 'authorization_code'
      ? HttpResponse.json({
          access_token: 'company-access',
          refresh_token: 'company-refresh',
          token_type: 'Bearer',
          expires_in: 86399,
          userType: 'Company',
          companyId: COMPANY,
          userId: 'user-1',
          scope: 'oauth.readonly oauth.write conversations/message.write',
        })
      : HttpResponse.json({ access_token: 'company-access-2', refresh_token: 'company-refresh-2', expires_in: 86399, userType: 'Company', companyId: COMPANY }),
  );
}

function installedLocations(items: { _id: string; name: string }[]) {
  ghl.on('GET', INSTALLED, () => HttpResponse.json({ items: items.map((i) => ({ ...i, isInstalled: true })), pagination: { hasNextPage: false } }));
}

async function seedAgency(expiresInMs = 86_400_000) {
  await saveCompanyTokens(COMPANY, { accessToken: 'company-access', refreshToken: 'company-refresh', expiresAt: new Date(Date.now() + expiresInMs) });
}

function postAppWebhook(payload: object, signature?: string | null) {
  const raw = JSON.stringify(payload);
  const req = api().post('/webhooks/ghl/app').set('Content-Type', 'application/json');
  const sig = signature === undefined ? signGhl(raw) : signature;
  if (sig !== null) req.set('X-GHL-Signature', sig);
  return req.send(raw);
}

describe('agency install via /oauth/callback', () => {
  it('stores the agency token and connects each installed location with its own encrypted Location token', async () => {
    agencyCodeExchange();
    installedLocations([
      { _id: 'loc-aryze', name: 'Aryze Tech' },
      { _id: 'loc-second', name: 'Second Location' },
    ]);

    const res = await api().get('/oauth/callback?code=AGENCY-CODE');

    expect(res.status).toBe(200);
    expect(res.text).toContain('App installed');
    expect(res.text).toContain('Aryze Tech, Second Location');

    // Installed locations were listed with the agency token, our app id, and only installed locations.
    const [list] = ghl.callsTo('GET', INSTALLED);
    expect(list.authorization).toBe('Bearer company-access');
    expect(list.version).toBe('v3');
    expect(list.query).toMatchObject({ companyId: COMPANY, appId: 'test-app-id', isInstalled: 'true' });

    // One location-token exchange per location, form-encoded, with the agency token.
    const mints = ghl.callsTo('POST', LOCATION_TOKEN);
    expect(mints.map((m) => m.body)).toEqual([
      { companyId: COMPANY, locationId: 'loc-aryze' },
      { companyId: COMPANY, locationId: 'loc-second' },
    ]);
    expect(mints[0].authorization).toBe('Bearer company-access');
    expect(mints[0].contentType).toContain('application/x-www-form-urlencoded');

    const agency = await prisma.agencyIntegration.findUniqueOrThrow({ where: { companyId: COMPANY } });
    expect(agency.ghlAccessToken).toMatch(/^v1:/);
    expect(decryptSecret(agency.ghlAccessToken)).toBe('company-access');
    expect(decryptSecret(agency.ghlRefreshToken)).toBe('company-refresh');

    const integrations = await prisma.integration.findMany({ orderBy: { locationId: 'asc' } });
    expect(integrations.map((i) => i.locationId)).toEqual(['loc-aryze', 'loc-second']);
    for (const i of integrations) {
      expect(i).toMatchObject({ companyId: COMPANY, conversationProviderId: 'test-provider-id' });
      expect(i.ghlAccessToken).toMatch(/^v1:/);
      expect(decryptSecret(i.ghlAccessToken)).toMatch(/^loc-access-\d+$/);
    }
  });

  it('follows pagination of installed locations', async () => {
    agencyCodeExchange();
    ghl.on('GET', INSTALLED, (call: GhlCall) =>
      call.query.pageToken === 'page-2'
        ? HttpResponse.json({ items: [{ _id: 'loc-b', name: 'B', isInstalled: true }], pagination: { hasNextPage: false } })
        : HttpResponse.json({ items: [{ _id: 'loc-a', name: 'A', isInstalled: true }], pagination: { hasNextPage: true, nextPageToken: 'page-2' } }),
    );

    await api().get('/oauth/callback?code=AGENCY-CODE');

    expect(ghl.callsTo('GET', INSTALLED)).toHaveLength(2);
    expect((await prisma.integration.findMany()).map((i) => i.locationId).sort()).toEqual(['loc-a', 'loc-b']);
  });

  it('falls back to the legacy paths when the v3 paths return 404', async () => {
    agencyCodeExchange();
    ghl.fail('GET', INSTALLED, 404);
    ghl.fail('POST', LOCATION_TOKEN, 404);
    ghl.on('GET', LEGACY_INSTALLED, () => HttpResponse.json({ locations: [{ _id: 'loc-legacy', name: 'Legacy', isInstalled: true }], count: 1 }));
    ghl.on('POST', LEGACY_LOCATION_TOKEN, () => HttpResponse.json({ access_token: 'legacy-access', refresh_token: 'legacy-refresh', expires_in: 86399, locationId: 'loc-legacy' }));

    const res = await api().get('/oauth/callback?code=AGENCY-CODE');

    expect(res.status).toBe(200);
    expect(ghl.callsTo('GET', LEGACY_INSTALLED)[0].query).toMatchObject({ companyId: COMPANY, appId: 'test-app-id', skip: '0' });
    const integration = await prisma.integration.findUniqueOrThrow({ where: { locationId: 'loc-legacy' } });
    expect(decryptSecret(integration.ghlAccessToken)).toBe('legacy-access');
  });

  it('connects the locations that work when one location token fails', async () => {
    agencyCodeExchange();
    installedLocations([
      { _id: 'loc-ok', name: 'OK Location' },
      { _id: 'loc-bad', name: 'Bad Location' },
    ]);
    ghl.on('POST', LOCATION_TOKEN, (call: GhlCall) =>
      call.body.locationId === 'loc-bad'
        ? HttpResponse.json({ message: 'boom' }, { status: 500 })
        : HttpResponse.json({ access_token: 'ok-access', refresh_token: 'ok-refresh', expires_in: 86399, locationId: 'loc-ok' }),
    );

    const res = await api().get('/oauth/callback?code=AGENCY-CODE');

    expect(res.status).toBe(200);
    expect(res.text).toContain('OK Location');
    expect(res.text).toContain('1 sub-account(s) could not be connected');
    expect((await prisma.integration.findMany()).map((i) => i.locationId)).toEqual(['loc-ok']);
  });

  it('explains when no sub-accounts are selected, and fails clearly when the scope is missing', async () => {
    agencyCodeExchange();
    installedLocations([]);
    const none = await api().get('/oauth/callback?code=AGENCY-CODE');
    expect(none.status).toBe(200);
    expect(none.text).toContain('no sub-accounts were selected');
    expect(await prisma.agencyIntegration.count()).toBe(1);

    ghl.reset();
    agencyCodeExchange();
    ghl.on('GET', INSTALLED, () => HttpResponse.json({ statusCode: 401, message: 'The token is not authorized for this scope.' }, { status: 401 }));
    const noScope = await api().get('/oauth/callback?code=AGENCY-CODE');
    expect(noScope.status).toBe(502);
    expect(await prisma.integration.count()).toBe(0);
  });

  it('refreshes an expiring agency token (user_type Company) before minting', async () => {
    await seedAgency(60_000);
    agencyCodeExchange(); // refresh grant returns company-access-2
    installedLocations([{ _id: 'loc-aryze', name: 'Aryze Tech' }]);

    const { connectAgencyLocations } = await import('../src/ghl/agency');
    const result = await connectAgencyLocations(COMPANY);

    expect(result.connected.map((l) => l.locationId)).toEqual(['loc-aryze']);
    const refresh = ghl.callsTo('POST', TOKEN)[0];
    expect(refresh.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'company-refresh', user_type: 'Company' });
    expect(ghl.callsTo('GET', INSTALLED)[0].authorization).toBe('Bearer company-access-2');
  });

  it('derives the app id from the client id when GHL_APP_ID is not set', () => {
    const saved = { appId: env.GHL_APP_ID, clientId: env.GHL_CLIENT_ID };
    try {
      env.GHL_APP_ID = undefined;
      env.GHL_CLIENT_ID = '665c6bb13d4e5364bdec0e2f-mawqjyjd';
      expect(ghlAppId()).toBe('665c6bb13d4e5364bdec0e2f');
    } finally {
      env.GHL_APP_ID = saved.appId;
      env.GHL_CLIENT_ID = saved.clientId;
    }
  });
});

describe('location token refresh for agency-installed locations', () => {
  it('re-mints the Location token from the agency token when the location refresh fails', async () => {
    await seedAgency();
    await saveTokens('loc-aryze', { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: new Date(Date.now() + 60_000) }, { companyId: COMPANY });
    ghl.on('POST', TOKEN, () => HttpResponse.json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, { status: 401 }));
    ghl.on('POST', LOCATION_TOKEN, () => HttpResponse.json({ access_token: 'reminted', refresh_token: 'reminted-refresh', expires_in: 86399, locationId: 'loc-aryze' }));

    const client = await getGhlClient('loc-aryze');
    await client.request('GET', '/contacts/c-1');

    expect(ghl.callsTo('POST', LOCATION_TOKEN)[0].body).toEqual({ companyId: COMPANY, locationId: 'loc-aryze' });
    expect(ghl.callsTo('GET', /^\/contacts\/c-1$/)[0].authorization).toBe('Bearer reminted');
    const integration = await prisma.integration.findUniqueOrThrow({ where: { locationId: 'loc-aryze' } });
    expect(decryptSecret(integration.ghlAccessToken)).toBe('reminted');
  });

  it('re-mints when the location has no refresh token stored', async () => {
    await seedAgency();
    await saveTokens('loc-aryze', { accessToken: 'old', refreshToken: '', expiresAt: new Date(Date.now() + 60_000) }, { companyId: COMPANY });

    await getGhlClient('loc-aryze');

    expect(ghl.callsTo('POST', TOKEN)).toHaveLength(0);
    expect(ghl.callsTo('POST', LOCATION_TOKEN)).toHaveLength(1);
  });

  it('still fails with REFRESH_FAILED for a location installed directly (no agency)', async () => {
    await saveTokens('loc-direct', { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: new Date(Date.now() + 60_000) });
    ghl.on('POST', TOKEN, () => HttpResponse.json({ error: 'invalid_grant' }, { status: 401 }));

    await expect(getGhlClient('loc-direct')).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
    expect(ghl.callsTo('POST', LOCATION_TOKEN)).toHaveLength(0);
  });
});

describe('POST /webhooks/ghl/app (App Install webhook)', () => {
  const install = (locationId: string) => ({ type: 'INSTALL', appId: 'test-app-id', installType: 'Location', locationId, companyId: COMPANY, userId: 'user-1' });

  it('connects a newly installed location using the stored agency token', async () => {
    await seedAgency();
    const res = await postAppWebhook(install('loc-new'));
    const { drainBackgroundTasks } = await import('../src/utils/background');
    await drainBackgroundTasks();

    expect(res.status).toBe(200);
    expect(ghl.callsTo('POST', LOCATION_TOKEN)[0].body).toEqual({ companyId: COMPANY, locationId: 'loc-new' });
    expect(await prisma.integration.findUniqueOrThrow({ where: { locationId: 'loc-new' } })).toMatchObject({
      companyId: COMPANY,
      conversationProviderId: 'test-provider-id',
    });
  });

  it('ignores installs without a stored agency token, already-connected locations and other events', async () => {
    const { drainBackgroundTasks } = await import('../src/utils/background');
    expect((await postAppWebhook(install('loc-x'))).status).toBe(200); // no agency token
    await seedAgency();
    await saveTokens('loc-existing', { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await postAppWebhook(install('loc-existing'))).status).toBe(200);
    expect((await postAppWebhook({ type: 'UNINSTALL', locationId: 'loc-existing', companyId: COMPANY })).status).toBe(200);
    await drainBackgroundTasks();

    expect(ghl.callsTo('POST', LOCATION_TOKEN)).toHaveLength(0);
    expect(await prisma.integration.count()).toBe(1);
  });

  it('rejects an invalid signature with 401', async () => {
    await seedAgency();
    expect((await postAppWebhook(install('loc-new'), 'bad-signature')).status).toBe(401);
    expect((await postAppWebhook(install('loc-new'), null)).status).toBe(401);
    expect(ghl.callsTo('POST', LOCATION_TOKEN)).toHaveLength(0);
  });
});
