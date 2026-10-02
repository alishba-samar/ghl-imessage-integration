import { z } from 'zod';
import { env } from '../config/env';

// Docs: https://marketplace.gohighlevel.com/docs/ (API reference). Every endpoint, including
// POST /oauth/token, documents a required "Version" header whose only listed option is "v3".
export const GHL_API_BASE_URL = 'https://services.leadconnectorhq.com';
export const GHL_API_VERSION = env.GHL_API_VERSION;
export const GHL_REQUEST_TIMEOUT_MS = 10_000;

export type GhlErrorCode =
  | 'NOT_CONFIGURED' // GHL_CLIENT_ID / GHL_CLIENT_SECRET / PUBLIC_BASE_URL missing
  | 'NOT_INSTALLED' // no Integration row for the location
  | 'TOKEN_REQUEST_FAILED' // code exchange rejected or returned an unexpected body
  | 'REFRESH_FAILED' // refresh token rejected; the location likely needs to reinstall the app
  | 'TOKEN_DECRYPT_FAILED' // stored tokens can't be decrypted (TOKEN_ENCRYPTION_KEY changed?)
  | 'API_ERROR' // non-2xx from a GHL API call
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

/** Errors from the GHL layer. Messages never contain tokens or client secrets. */
export class GhlError extends Error {
  constructor(
    readonly code: GhlErrorCode,
    message: string,
    readonly details: { httpStatus?: number; path?: string; locationId?: string; ghlError?: string } = {},
  ) {
    super(message);
    this.name = 'GhlError';
  }
}

// GHL error bodies vary: OAuth errors use { error, error_description }, API errors { statusCode, message }.
const errorBodySchema = z
  .object({
    error: z.string().optional(),
    error_description: z.string().optional(),
    message: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .partial();

/** Short, token-free description of a GHL error body. */
export function describeErrorBody(body: unknown): string | undefined {
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  const { error, error_description, message } = parsed.data;
  const msg = Array.isArray(message) ? message.join('; ') : message;
  return [error, error_description, msg].filter(Boolean).join(': ') || undefined;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

/** fetch with timeout and JSON parsing. Network failures become GhlError; HTTP errors are returned to the caller. */
export async function ghlFetch(url: string, init: RequestInit, path: string): Promise<RawResponse> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new GhlError('TIMEOUT', `GHL request timed out after ${GHL_REQUEST_TIMEOUT_MS}ms`, { path });
    }
    throw new GhlError('NETWORK_ERROR', `GHL request failed: ${err instanceof Error ? err.message : String(err)}`, { path });
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}
