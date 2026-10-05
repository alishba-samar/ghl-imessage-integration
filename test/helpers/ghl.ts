import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// In-memory stand-in for the GHL API (https://services.leadconnectorhq.com). Every request is recorded;
// tests can override any route with ghl.on(). Must not import app code (see test/setup.ts).

export interface GhlCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  authorization: string | null;
  version: string | null;
  contentType: string | null;
}

type Handler = (call: GhlCall) => Response | Promise<Response>;
interface Override {
  method: string;
  path: RegExp;
  handler: Handler;
}

let counter = 0;
const next = () => ++counter;

export const ghl = {
  calls: [] as GhlCall[],
  overrides: [] as Override[],
  /** locationId returned by POST /oauth/token. */
  tokenLocationId: 'loc-1',

  /** Override a route for the current test (first match wins; reset after each test). */
  on(method: string, path: RegExp, handler: Handler): void {
    this.overrides.unshift({ method, path, handler });
  },
  /** Make a route fail with an HTTP error for the current test. */
  fail(method: string, path: RegExp, status = 500): void {
    this.on(method, path, () => HttpResponse.json({ statusCode: status, message: 'Simulated GHL failure' }, { status }));
  },
  callsTo(method: string, path: RegExp): GhlCall[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  },
  reset(): void {
    this.calls = [];
    this.overrides = [];
    this.tokenLocationId = 'loc-1';
  },
};

function defaultResponse(call: GhlCall): Response {
  const { method, path } = call;
  if (method === 'POST' && path === '/oauth/token') {
    const n = next();
    return HttpResponse.json({
      access_token: `access-${n}`,
      refresh_token: `refresh-${n}`,
      token_type: 'Bearer',
      expires_in: 86399,
      userType: 'Location',
      locationId: ghl.tokenLocationId,
      companyId: 'company-1',
      userId: 'user-1',
    });
  }
  if (method === 'GET' && path === '/contacts/search/duplicate') {
    return HttpResponse.json({ contact: { id: `contact-${(call.query.number ?? '').slice(-4)}` } });
  }
  if (method === 'GET' && path === '/oauth/installed-locations') {
    return HttpResponse.json({ items: [], pagination: { hasNextPage: false } });
  }
  if (method === 'POST' && path === '/oauth/location-token') {
    const n = next();
    return HttpResponse.json({
      access_token: `loc-access-${n}`,
      refresh_token: `loc-refresh-${n}`,
      token_type: 'Bearer',
      expires_in: 86399,
      locationId: call.body?.locationId,
      userId: 'user-1',
      appId: 'test-app-id',
    });
  }
  if (method === 'GET' && /^\/contacts\/[^/]+$/.test(path)) {
    return HttpResponse.json({ contact: { id: path.split('/')[2] } });
  }
  if (method === 'POST' && path === '/contacts/upsert') {
    return HttpResponse.json({ new: true, contact: { id: 'contact-new' } });
  }
  if (method === 'POST' && path === '/conversations/messages/inbound') {
    return HttpResponse.json({ success: true, conversationId: 'conv-1', messageId: `ghl-in-${next()}`, message: 'ok' });
  }
  if (method === 'POST' && path === '/conversations/messages') {
    return HttpResponse.json({ conversationId: 'conv-1', messageId: `ghl-msg-${next()}`, msg: 'Message queued successfully.' });
  }
  if (method === 'PUT' && /^\/conversations\/messages\/[^/]+\/status$/.test(path)) {
    return HttpResponse.json({ conversationId: 'conv-1', messageId: path.split('/')[3] });
  }
  if (/^\/contacts\/[^/]+\/tags$/.test(path) && (method === 'POST' || method === 'DELETE')) {
    return HttpResponse.json({ tags: call.body?.tags ?? [] }, { status: method === 'POST' ? 201 : 200 });
  }
  return HttpResponse.json({ statusCode: 404, message: `No GHL stub for ${method} ${path}` }, { status: 404 });
}

export const ghlServer = setupServer(
  http.all('https://services.leadconnectorhq.com/*', async ({ request }) => {
    const url = new URL(request.url);
    const text = await request.text();
    const contentType = request.headers.get('content-type');
    let body: any = undefined;
    if (text) {
      body = contentType?.includes('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(text))
        : JSON.parse(text);
    }
    const call: GhlCall = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: request.headers.get('authorization'),
      version: request.headers.get('version'),
      contentType,
    };
    ghl.calls.push(call);
    const override = ghl.overrides.find((o) => o.method === call.method && o.path.test(call.path));
    return override ? override.handler(call) : defaultResponse(call);
  }),
);
