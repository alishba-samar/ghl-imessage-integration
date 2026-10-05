import { z } from 'zod';
import { env } from '../config/env';
import { GHL_API_BASE_URL, GHL_API_VERSION, GhlError, describeErrorBody, ghlFetch } from './http';

// Docs: https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0 and
// https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token (POST /oauth/token,
// application/x-www-form-urlencoded, user_type "Location" for sub-account tokens).

const TOKEN_PATH = '/oauth/token';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  userType: z.string().optional(),
  locationId: z.string().optional(),
  companyId: z.string().optional(),
  userId: z.string().optional(),
});

export interface GhlTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  userType?: string;
  locationId?: string;
  companyId?: string;
  scope?: string;
}

/**
 * The redirect_uri sent on token requests. It must match the Redirect URL registered on the GHL app, which may
 * differ from where this server runs (GHL_OAUTH_REDIRECT_URI), e.g. while the server sits behind a changing tunnel.
 */
export function redirectUri(): string {
  if (env.GHL_OAUTH_REDIRECT_URI) return env.GHL_OAUTH_REDIRECT_URI;
  if (!env.PUBLIC_BASE_URL) throw new GhlError('NOT_CONFIGURED', 'GHL_OAUTH_REDIRECT_URI or PUBLIC_BASE_URL must be set');
  return `${env.PUBLIC_BASE_URL}/oauth/callback`;
}

function clientCredentials(): { client_id: string; client_secret: string } {
  if (!env.GHL_CLIENT_ID || !env.GHL_CLIENT_SECRET) {
    throw new GhlError('NOT_CONFIGURED', 'GHL_CLIENT_ID and GHL_CLIENT_SECRET must be set');
  }
  return { client_id: env.GHL_CLIENT_ID, client_secret: env.GHL_CLIENT_SECRET };
}

/**
 * Exchanges the authorization code from /oauth/callback. We ask for a Location token, but when an agency user
 * installs the app GHL returns a Company token instead (docs: Authorization/TargetUserSubAccount); the callback
 * then exchanges it for Location tokens (see agency.ts).
 */
export function exchangeCode(code: string): Promise<GhlTokens> {
  return requestToken(
    { grant_type: 'authorization_code', code, user_type: 'Location', redirect_uri: redirectUri() },
    'TOKEN_REQUEST_FAILED',
  );
}

/**
 * Exchanges a refresh token for new tokens. GHL refresh tokens are single-use: after this succeeds the
 * old refresh token is invalid, so the returned tokens must be saved.
 */
export function refreshTokens(refreshToken: string, userType: 'Location' | 'Company' = 'Location'): Promise<GhlTokens> {
  return requestToken(
    { grant_type: 'refresh_token', refresh_token: refreshToken, user_type: userType, redirect_uri: redirectUri() },
    'REFRESH_FAILED',
  );
}

async function requestToken(params: Record<string, string>, failureCode: 'TOKEN_REQUEST_FAILED' | 'REFRESH_FAILED'): Promise<GhlTokens> {
  const form = new URLSearchParams({ ...clientCredentials(), ...params });
  const res = await ghlFetch(
    `${GHL_API_BASE_URL}${TOKEN_PATH}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Version: GHL_API_VERSION,
      },
      body: form,
    },
    TOKEN_PATH,
  );

  if (!res.ok) {
    const ghlError = describeErrorBody(res.body);
    throw new GhlError(failureCode, `GHL token request failed with HTTP ${res.status}${ghlError ? ` (${ghlError})` : ''}`, {
      httpStatus: res.status,
      path: TOKEN_PATH,
      ghlError,
    });
  }

  const parsed = tokenResponseSchema.safeParse(res.body);
  if (!parsed.success) {
    throw new GhlError(failureCode, 'GHL token response was missing required fields', { httpStatus: res.status, path: TOKEN_PATH });
  }

  const t = parsed.data;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: new Date(Date.now() + t.expires_in * 1000),
    userType: t.userType,
    locationId: t.locationId,
    companyId: t.companyId,
    scope: t.scope,
  };
}
