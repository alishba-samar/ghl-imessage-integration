import { prisma } from '../config/db';
import { decryptSecret, encryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import { GHL_API_BASE_URL, GHL_API_VERSION, GhlError, describeErrorBody, ghlFetch } from './http';
import { mintLocationToken } from './agency';
import { refreshTokens, type GhlTokens } from './oauth';

/** Refresh when the access token expires within this window. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

interface AccessToken {
  value: string;
  expiresAt: Date | null;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface GhlRequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface GhlClient {
  readonly locationId: string;
  /** Calls the GHL API. Returns the parsed JSON body; throws GhlError on non-2xx, timeout or network error. */
  request<T = unknown>(method: HttpMethod, path: string, options?: GhlRequestOptions): Promise<T>;
}

/** Saves tokens for a location (encrypted), creating the Integration if needed. */
export async function saveTokens(
  locationId: string,
  tokens: GhlTokens,
  extra: { conversationProviderId?: string; companyId?: string } = {},
): Promise<void> {
  const data = {
    ghlAccessToken: encryptSecret(tokens.accessToken),
    ghlRefreshToken: encryptSecret(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
    ...(extra.conversationProviderId && { conversationProviderId: extra.conversationProviderId }),
    ...(extra.companyId && { companyId: extra.companyId }),
  };
  await prisma.integration.upsert({ where: { locationId }, create: { locationId, ...data }, update: data });
}

/**
 * Returns an API client for a location that has installed the app. Refreshes the access token first
 * if it expires within 5 minutes, and again before any request once the client's token gets close to expiry.
 */
export async function getGhlClient(locationId: string): Promise<GhlClient> {
  let token = await getAccessToken(locationId);

  return {
    locationId,
    async request<T>(method: HttpMethod, path: string, options: GhlRequestOptions = {}): Promise<T> {
      if (expiresSoon(token.expiresAt)) token = await getAccessToken(locationId);

      const url = new URL(path, GHL_API_BASE_URL);
      for (const [k, v] of Object.entries(options.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }

      const hasBody = options.body !== undefined;
      const res = await ghlFetch(
        url.toString(),
        {
          method,
          headers: {
            Authorization: `Bearer ${token.value}`,
            Version: GHL_API_VERSION,
            Accept: 'application/json',
            ...(hasBody && { 'Content-Type': 'application/json' }),
          },
          body: hasBody ? JSON.stringify(options.body) : undefined,
        },
        url.pathname,
      );

      if (!res.ok) {
        const ghlError = describeErrorBody(res.body);
        throw new GhlError('API_ERROR', `GHL ${method} ${url.pathname} failed with HTTP ${res.status}${ghlError ? ` (${ghlError})` : ''}`, {
          httpStatus: res.status,
          path: url.pathname,
          locationId,
          ghlError,
        });
      }
      return res.body as T;
    },
  };
}

async function getAccessToken(locationId: string): Promise<AccessToken> {
  const integration = await prisma.integration.findUnique({ where: { locationId } });
  if (!integration) throw new GhlError('NOT_INSTALLED', `No GHL integration for location ${locationId}`, { locationId });

  if (!expiresSoon(integration.tokenExpiresAt)) {
    return { value: decrypt(integration.ghlAccessToken, locationId), expiresAt: integration.tokenExpiresAt };
  }
  return refreshOnce(locationId);
}

// In-process guard: concurrent callers for the same location share one refresh.
const inflightRefreshes = new Map<string, Promise<AccessToken>>();

function refreshOnce(locationId: string): Promise<AccessToken> {
  let pending = inflightRefreshes.get(locationId);
  if (!pending) {
    pending = refreshWithRowLock(locationId).finally(() => inflightRefreshes.delete(locationId));
    inflightRefreshes.set(locationId, pending);
  }
  return pending;
}

/**
 * Cross-process guard: locks the Integration row (SELECT ... FOR UPDATE) for the duration of the refresh,
 * then re-checks expiry, so another server instance that refreshed first is respected. This matters because
 * GHL refresh tokens are single-use: a second refresh with the old token would fail.
 */
async function refreshWithRowLock(locationId: string): Promise<AccessToken> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Integration" WHERE "locationId" = ${locationId} FOR UPDATE`;
      const row = await tx.integration.findUnique({ where: { locationId } });
      if (!row) throw new GhlError('NOT_INSTALLED', `No GHL integration for location ${locationId}`, { locationId });

      if (!expiresSoon(row.tokenExpiresAt)) {
        return { value: decrypt(row.ghlAccessToken, locationId), expiresAt: row.tokenExpiresAt };
      }

      let tokens: GhlTokens;
      try {
        const refreshToken = decrypt(row.ghlRefreshToken, locationId);
        // Location tokens minted from an agency token may come without a refresh token.
        if (!refreshToken) throw new GhlError('REFRESH_FAILED', 'No refresh token stored for this location', { locationId });
        tokens = await refreshTokens(refreshToken);
      } catch (err) {
        if (err instanceof GhlError) {
          logger.warn({ locationId, code: err.code, ...err.details }, 'GHL token refresh failed');
        }
        // Installed by an agency: mint a new Location token from the agency token instead.
        if (!(err instanceof GhlError && err.code === 'REFRESH_FAILED') || !row.companyId) throw err;
        tokens = await mintLocationToken(row.companyId, locationId);
        logger.info({ locationId, companyId: row.companyId }, 'GHL location token re-minted from agency token');
      }

      await tx.integration.update({
        where: { locationId },
        data: {
          ghlAccessToken: encryptSecret(tokens.accessToken),
          ghlRefreshToken: encryptSecret(tokens.refreshToken),
          tokenExpiresAt: tokens.expiresAt,
        },
      });
      logger.info({ locationId, expiresAt: tokens.expiresAt }, 'GHL access token refreshed');
      return { value: tokens.accessToken, expiresAt: tokens.expiresAt };
    },
    // The refresh HTTP call (10s timeout) runs inside the transaction.
    { maxWait: 10_000, timeout: 20_000 },
  );
}

function expiresSoon(expiresAt: Date | null): boolean {
  return !expiresAt || expiresAt.getTime() - Date.now() < REFRESH_WINDOW_MS;
}

function decrypt(value: string, locationId: string): string {
  try {
    return decryptSecret(value);
  } catch {
    throw new GhlError('TOKEN_DECRYPT_FAILED', `Stored GHL tokens for ${locationId} could not be decrypted`, { locationId });
  }
}
