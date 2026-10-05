import { z } from 'zod';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { decryptSecret, encryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import { saveTokens } from './ghlClient';
import { GHL_API_BASE_URL, GHL_API_VERSION, GhlError, describeErrorBody, ghlFetch, type RawResponse } from './http';
import { refreshTokens, type GhlTokens } from './oauth';

// Agency (Company) installs. When an agency user installs our Sub-Account app, the code exchange returns a
// Company token; Location tokens are minted from it per installed location.
// Docs (v3):  GET  /oauth/installed-locations  https://marketplace.gohighlevel.com/docs/ghl/oauth/get-installed-location
//             POST /oauth/location-token      https://marketplace.gohighlevel.com/docs/ghl/oauth/get-location-access-token
// Older docs (2021-07-28, and the Scopes / Target User pages) use /oauth/installedLocations and /oauth/locationToken;
// we call the v3 path and fall back to the legacy one on 404.
// Scopes (Scopes page, access type "Agency"): oauth.readonly (installed locations), oauth.write (location token).

const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export interface InstalledLocation {
  locationId: string;
  name?: string;
}

export interface AgencyInstallResult {
  companyId: string;
  connected: InstalledLocation[];
  failed: (InstalledLocation & { error: string })[];
}

/** The Marketplace app id: GHL_APP_ID, or the part of GHL_CLIENT_ID before the first "-". */
export function ghlAppId(): string {
  const appId = env.GHL_APP_ID ?? env.GHL_CLIENT_ID?.split('-')[0];
  if (!appId) throw new GhlError('NOT_CONFIGURED', 'GHL_APP_ID (or GHL_CLIENT_ID) must be set for agency installs');
  return appId;
}

/** Saves an agency's Company token (encrypted). */
export async function saveCompanyTokens(companyId: string, tokens: GhlTokens): Promise<void> {
  const data = {
    ghlAccessToken: encryptSecret(tokens.accessToken),
    ghlRefreshToken: encryptSecret(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
  };
  await prisma.agencyIntegration.upsert({ where: { companyId }, create: { companyId, ...data }, update: data });
}

/**
 * Handles an agency install: lists the locations the app is installed on and stores a Location token for each.
 * One location failing doesn't stop the others.
 */
export async function connectAgencyLocations(companyId: string): Promise<AgencyInstallResult> {
  const locations = await listInstalledLocations(companyId);
  const result: AgencyInstallResult = { companyId, connected: [], failed: [] };
  for (const location of locations) {
    try {
      await connectLocationFromAgency(companyId, location.locationId);
      result.connected.push(location);
    } catch (err) {
      const error = err instanceof GhlError ? err.message : String(err);
      logger.error({ companyId, locationId: location.locationId, error }, 'Failed to connect location from agency install');
      result.failed.push({ ...location, error });
    }
  }
  logger.info(
    { companyId, connected: result.connected.map((l) => l.locationId), failed: result.failed.map((l) => l.locationId) },
    'Agency install processed',
  );
  return result;
}

/** Mints a Location token from the agency token and saves it as the location's Integration. */
export async function connectLocationFromAgency(companyId: string, locationId: string): Promise<void> {
  const tokens = await mintLocationToken(companyId, locationId);
  await saveTokens(locationId, tokens, { conversationProviderId: env.GHL_CONVERSATION_PROVIDER_ID, companyId });
  logger.info({ companyId, locationId, expiresAt: tokens.expiresAt }, 'Location connected via agency token');
}

const locationTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  // Documented but not marked required; when absent we re-mint from the agency token instead of refreshing.
  refresh_token: z.string().optional(),
  locationId: z.string().optional(),
  scope: z.string().optional(),
});

/** POST /oauth/location-token (legacy /oauth/locationToken) with the agency token. */
export async function mintLocationToken(companyId: string, locationId: string): Promise<GhlTokens> {
  const res = await agencyRequest(companyId, 'POST', ['/oauth/location-token', '/oauth/locationToken'], {
    form: { companyId, locationId },
  });
  if (!res.ok) throw apiError('location token', res, 'oauth.write');
  const parsed = locationTokenSchema.safeParse(res.body);
  if (!parsed.success) {
    throw new GhlError('API_ERROR', 'GHL location token response was missing required fields', { path: res.path, httpStatus: res.status });
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? '',
    expiresAt: new Date(Date.now() + parsed.data.expires_in * 1000),
    userType: 'Location',
    locationId: parsed.data.locationId ?? locationId,
    companyId,
    scope: parsed.data.scope,
  };
}

const locationItemSchema = z.object({ _id: z.string(), name: z.string().optional(), isInstalled: z.boolean().optional() });
const installedLocationsSchema = z.object({
  items: z.array(locationItemSchema).optional(), // v3
  locations: z.array(locationItemSchema).optional(), // 2021-07-28
  pagination: z.object({ nextPageToken: z.string().nullish(), hasNextPage: z.boolean().optional() }).partial().optional(),
});

/** GET /oauth/installed-locations (legacy /oauth/installedLocations): locations with the app installed. */
export async function listInstalledLocations(companyId: string): Promise<InstalledLocation[]> {
  const appId = ghlAppId();
  const found: InstalledLocation[] = [];
  let pageToken: string | undefined;
  let skip = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await agencyRequest(companyId, 'GET', ['/oauth/installed-locations', '/oauth/installedLocations'], {
      query: (path) =>
        path === '/oauth/installed-locations'
          ? { companyId, appId, isInstalled: 'true', pageSize: String(PAGE_SIZE), pageToken }
          : { companyId, appId, isInstalled: 'true', limit: String(PAGE_SIZE), skip: String(skip) },
    });
    if (!res.ok) throw apiError('installed locations', res, 'oauth.readonly');
    const parsed = installedLocationsSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new GhlError('API_ERROR', 'GHL installed locations response was not recognized', { path: res.path, httpStatus: res.status });
    }
    const items = parsed.data.items ?? parsed.data.locations ?? [];
    for (const item of items) {
      if (item.isInstalled !== false) found.push({ locationId: item._id, name: item.name });
    }

    if (res.path === '/oauth/installed-locations') {
      pageToken = parsed.data.pagination?.nextPageToken ?? undefined;
      if (!pageToken || parsed.data.pagination?.hasNextPage === false) break;
    } else {
      if (items.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    }
  }
  return found;
}

/** Calls an agency endpoint with the (fresh) Company token, trying each path in order on 404. */
async function agencyRequest(
  companyId: string,
  method: 'GET' | 'POST',
  paths: [string, string],
  opts: { form?: Record<string, string>; query?: (path: string) => Record<string, string | undefined> },
): Promise<RawResponse & { path: string }> {
  const token = await getCompanyAccessToken(companyId);
  let last: (RawResponse & { path: string }) | undefined;
  for (const path of paths) {
    const url = new URL(path, GHL_API_BASE_URL);
    for (const [k, v] of Object.entries(opts.query?.(path) ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const res = await ghlFetch(
      url.toString(),
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: GHL_API_VERSION,
          Accept: 'application/json',
          ...(opts.form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
        },
        body: opts.form ? new URLSearchParams(opts.form) : undefined,
      },
      path,
    );
    last = { ...res, path };
    if (res.status !== 404) return last;
    logger.warn({ companyId, path }, 'GHL agency endpoint returned 404; trying legacy path');
  }
  return last!;
}

function apiError(what: string, res: RawResponse & { path: string }, scope: string): GhlError {
  const ghlError = describeErrorBody(res.body);
  const hint = res.status === 401 || res.status === 403 ? ` Check that the app has the "${scope}" scope.` : '';
  return new GhlError('API_ERROR', `GHL ${what} request failed with HTTP ${res.status}${ghlError ? ` (${ghlError})` : ''}.${hint}`, {
    httpStatus: res.status,
    path: res.path,
    ghlError,
  });
}

// --- Company token storage and refresh (same pattern as Location tokens in ghlClient.ts) ---

const inflightRefreshes = new Map<string, Promise<string>>();

/** Returns a valid Company access token, refreshing it (once, even with concurrent callers) when it's about to expire. */
export async function getCompanyAccessToken(companyId: string): Promise<string> {
  const agency = await prisma.agencyIntegration.findUnique({ where: { companyId } });
  if (!agency) throw new GhlError('NOT_INSTALLED', `No agency integration for company ${companyId}`);
  if (!expiresSoon(agency.tokenExpiresAt)) return decrypt(agency.ghlAccessToken, companyId);

  let pending = inflightRefreshes.get(companyId);
  if (!pending) {
    pending = refreshCompanyToken(companyId).finally(() => inflightRefreshes.delete(companyId));
    inflightRefreshes.set(companyId, pending);
  }
  return pending;
}

async function refreshCompanyToken(companyId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AgencyIntegration" WHERE "companyId" = ${companyId} FOR UPDATE`;
    const row = await tx.agencyIntegration.findUniqueOrThrow({ where: { companyId } });
    if (!expiresSoon(row.tokenExpiresAt)) return decrypt(row.ghlAccessToken, companyId);

    let tokens: GhlTokens;
    try {
      tokens = await refreshTokens(decrypt(row.ghlRefreshToken, companyId), 'Company');
    } catch (err) {
      if (err instanceof GhlError) logger.warn({ companyId, code: err.code, ...err.details }, 'GHL agency token refresh failed');
      throw err;
    }
    await tx.agencyIntegration.update({
      where: { companyId },
      data: {
        ghlAccessToken: encryptSecret(tokens.accessToken),
        ghlRefreshToken: encryptSecret(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
      },
    });
    logger.info({ companyId, expiresAt: tokens.expiresAt }, 'GHL agency token refreshed');
    return tokens.accessToken;
  });
}

function expiresSoon(expiresAt: Date | null): boolean {
  return !expiresAt || expiresAt.getTime() - Date.now() < REFRESH_WINDOW_MS;
}

function decrypt(value: string, companyId: string): string {
  try {
    return decryptSecret(value);
  } catch {
    throw new GhlError('TOKEN_DECRYPT_FAILED', `Stored GHL agency tokens for ${companyId} could not be decrypted`);
  }
}
