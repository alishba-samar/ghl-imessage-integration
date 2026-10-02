import { z } from 'zod';
import { logger } from '../utils/logger';
import type { IMessageProvider } from './IMessageProvider';
import type {
  Capability,
  DeliveryService,
  InboundMessage,
  MessageStatus,
  SendMessageInput,
  SendMessageResult,
  StatusUpdate,
} from './types';

// Docs: https://docs.sendblue.com/api (endpoint reference), /getting-started/sending-messages,
// /getting-started/receiving-messages, /getting-started/webhooks, /guides/check-imessage-support.
const REQUEST_TIMEOUT_MS = 10_000;

export interface SendblueConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Used when SendMessageInput.from is empty. */
  fromNumber: string;
}

// Documented as an int, but string codes such as "SMS_LIMIT_REACHED" also appear.
const errorCodeSchema = z.union([z.number(), z.string()]).nullish();

/**
 * Message object shared by the send-message / status responses and the receive / outbound
 * webhooks. Only the fields we use are listed; unknown fields are ignored.
 */
const sendblueMessageSchema = z.object({
  message_handle: z.string().min(1),
  status: z.string().nullish(),
  is_outbound: z.boolean().nullish(),
  content: z.string().nullish(),
  media_url: z.string().nullish(),
  from_number: z.string().nullish(),
  to_number: z.string().nullish(),
  number: z.string().nullish(),
  sendblue_number: z.string().nullish(),
  group_id: z.string().nullish(),
  date_sent: z.string().nullish(),
  date_created: z.string().nullish(),
  error_code: errorCodeSchema,
  error_key: z.string().nullish(),
  error_message: z.string().nullish(),
  error_reason: z.string().nullish(),
  error_detail: z.string().nullish(),
  opted_out: z.boolean().nullish(),
  service: z.string().nullish(),
  was_downgraded: z.boolean().nullish(),
});

type SendblueMessage = z.infer<typeof sendblueMessageSchema>;

/** Documented error body: { status: "ERROR", error_code, message }. */
const sendblueErrorSchema = z.object({
  error_code: errorCodeSchema,
  code: z.string().nullish(),
  message: z.string().nullish(),
});

const evaluateServiceSchema = z.object({
  service: z.enum(['iMessage', 'SMS']),
});

/**
 * Error codes where retrying the same message cannot succeed:
 * 4000 validation error (e.g. malformed/invalid number), 4002 blacklisted number.
 * Rate-limit (4001, 5003, 5509, SMS_LIMIT_REACHED) and internal (5000, 10001, 10002) codes are transient.
 */
const PERMANENT_ERROR_CODES = new Set(['4000', '4002']);

type FetchOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number | null; body: unknown; errorCode: string; errorMessage: string };

export class SendblueProvider implements IMessageProvider {
  readonly name = 'sendblue';

  constructor(private readonly config: SendblueConfig) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const payload = {
      number: input.to,
      from_number: input.from || this.config.fromNumber,
      // Sendblue requires content or media_url; omit empty content for media-only sends.
      content: input.content || undefined,
      media_url: input.mediaUrl,
      // input.statusCallbackUrl is deliberately not sent as status_callback: Sendblue sends per-message
      // callbacks without the sb-signing-secret header, so our webhook auth rejects them. Statuses arrive
      // via the account-level "outbound" webhook (configured in Sendblue) instead, which carries the secret.
    };

    const res = await this.request('POST', '/api/send-message', { body: payload });

    if (!res.ok) {
      logger.warn(
        { provider: this.name, to: input.to, httpStatus: res.status, errorCode: res.errorCode },
        'Sendblue send-message failed',
      );
      return { status: 'FAILED', errorCode: res.errorCode, errorMessage: res.errorMessage };
    }

    const parsed = sendblueMessageSchema.safeParse(res.body);
    if (!parsed.success) {
      logger.error({ provider: this.name, to: input.to }, 'Sendblue send-message returned an unexpected body');
      return {
        status: 'FAILED',
        errorCode: 'INVALID_RESPONSE',
        errorMessage: 'Sendblue response did not include a message_handle',
      };
    }

    const msg = parsed.data;
    const status = hasError(msg) ? 'FAILED' : mapSendStatus(msg.status);
    const result: SendMessageResult = { providerMessageId: msg.message_handle, status, ...channelOf(msg) };
    if (status === 'FAILED') {
      result.errorCode = errorCodeOf(msg);
      result.errorMessage = errorMessageOf(msg);
    }

    logger.info(
      { provider: this.name, to: input.to, providerMessageId: msg.message_handle, sendblueStatus: msg.status, status },
      'Sendblue message submitted',
    );
    return result;
  }

  /**
   * GET /api/evaluate-service. 200 + "iMessage" → available, 200 + "SMS" → unavailable.
   * Anything else (502 EVALUATE_SERVICE_INDETERMINATE, 403 plan not allowed, 429 lookup quota,
   * timeouts) → unknown. Lookups are limited to 30/hour and 100/day per line, so callers should cache.
   */
  async checkCapability(phone: string): Promise<Capability> {
    const res = await this.request('GET', '/api/evaluate-service', { query: { number: phone } });
    if (!res.ok) {
      logger.warn(
        { provider: this.name, httpStatus: res.status, errorCode: res.errorCode },
        'Sendblue evaluate-service inconclusive',
      );
      return 'unknown';
    }

    const parsed = evaluateServiceSchema.safeParse(res.body);
    if (!parsed.success) return 'unknown';
    return parsed.data.service === 'iMessage' ? 'available' : 'unavailable';
  }

  /**
   * GET /api/status?handle=... Returns null if the lookup fails, or if the message has not reached
   * SENT/DELIVERED/ERROR yet (StatusUpdate has no in-progress state).
   */
  async getMessageStatus(providerMessageId: string): Promise<StatusUpdate | null> {
    const res = await this.request('GET', '/api/status', { query: { handle: providerMessageId } });
    if (!res.ok) {
      logger.warn(
        { provider: this.name, providerMessageId, httpStatus: res.status, errorCode: res.errorCode },
        'Sendblue status lookup failed',
      );
      return null;
    }

    const parsed = sendblueMessageSchema.safeParse(unwrapNestedStatus(res.body));
    return parsed.success ? toStatusUpdate(parsed.data) : null;
  }

  /** Parses a `receive` webhook. Returns null for outbound events, group messages, or unknown shapes. */
  parseInboundWebhook(body: unknown): InboundMessage | null {
    const parsed = sendblueMessageSchema.safeParse(body);
    if (!parsed.success) return null;
    const msg = parsed.data;

    if (msg.is_outbound !== false) return null;
    // Group messages need group handling this interface doesn't model yet.
    if (msg.group_id) return null;
    if (!msg.from_number) return null;

    const to = msg.to_number || msg.sendblue_number;
    if (!to) return null;

    return {
      providerMessageId: msg.message_handle,
      from: msg.from_number,
      to,
      content: msg.content ?? '',
      mediaUrl: msg.media_url || undefined,
      receivedAt: parseDate(msg.date_sent) ?? new Date(),
    };
  }

  /**
   * Parses a `status_callback` / `outbound` webhook. Returns null for inbound events, unknown
   * shapes, and in-progress statuses (REGISTERED, PENDING, QUEUED, ACCEPTED).
   */
  parseStatusWebhook(body: unknown): StatusUpdate | null {
    const parsed = sendblueMessageSchema.safeParse(body);
    if (!parsed.success) return null;
    if (parsed.data.is_outbound !== true) return null;
    return toStatusUpdate(parsed.data);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; query?: Record<string, string> } = {},
  ): Promise<FetchOutcome> {
    const url = new URL(path, this.config.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'sb-api-key-id': this.config.apiKey,
          'sb-api-secret-key': this.config.apiSecret,
          ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return {
        ok: false,
        status: null,
        body: null,
        errorCode: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        errorMessage: timedOut
          ? `Sendblue request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `Sendblue request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    // Raw body only (never request/response headers, which carry credentials). Contains phone
    // numbers and message content, so it is debug-level only: enable with LOG_LEVEL=debug.
    logger.debug(
      { provider: this.name, method, path, httpStatus: response.status, body },
      'Sendblue raw response',
    );

    if (response.ok) return { ok: true, status: response.status, body };

    const err = sendblueErrorSchema.safeParse(body);
    const apiCode = err.success ? (err.data.error_code ?? err.data.code) : undefined;
    return {
      ok: false,
      status: response.status,
      body,
      errorCode: apiCode != null ? String(apiCode) : `HTTP_${response.status}`,
      errorMessage: (err.success && err.data.message) || `Sendblue returned HTTP ${response.status}`,
    };
  }
}

/**
 * The docs show GET /api/status returning a message object with a string `status`, but the live API
 * (observed 2026-10-01) returns `{ "status": { "status": "SENT" }, "message_handle": "..." }` with no
 * service / was_downgraded / error fields. Flatten the nested form; leave the documented form as is.
 */
function unwrapNestedStatus(body: unknown): unknown {
  if (body && typeof body === 'object' && 'status' in body) {
    const status = (body as { status: unknown }).status;
    if (status && typeof status === 'object' && 'status' in status) {
      return { ...body, ...status };
    }
  }
  return body;
}

/** Status after a successful send-message call. */
function mapSendStatus(status: string | null | undefined): MessageStatus {
  switch (status) {
    case 'SENT':
      return 'SENT';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'ERROR':
    case 'DECLINED':
      return 'FAILED';
    default:
      // REGISTERED, PENDING, QUEUED, ACCEPTED, or missing.
      return 'QUEUED';
  }
}

function toStatusUpdate(msg: SendblueMessage): StatusUpdate | null {
  let status: StatusUpdate['status'];
  if (msg.status === 'ERROR' || msg.status === 'DECLINED' || hasError(msg)) status = 'FAILED';
  else if (msg.status === 'DELIVERED') status = 'DELIVERED';
  else if (msg.status === 'SENT') status = 'SENT';
  else return null;

  const update: StatusUpdate = { providerMessageId: msg.message_handle, status, ...channelOf(msg) };
  if (status === 'FAILED') {
    update.errorCode = errorCodeOf(msg);
    update.errorMessage = errorMessageOf(msg);
    update.isPermanentFailure = isPermanentFailure(msg);
  }
  return update;
}

/** Sendblue reports service as "iMessage", "SMS"/"sms" (docs use both) or "RCS"; matched case-insensitively. */
function channelOf(msg: SendblueMessage): { service?: DeliveryService; wasDowngraded?: boolean } {
  const out: { service?: DeliveryService; wasDowngraded?: boolean } = {};
  const service = msg.service?.toLowerCase();
  if (service === 'imessage' || service === 'sms' || service === 'rcs') out.service = service;
  if (msg.was_downgraded != null) out.wasDowngraded = msg.was_downgraded;
  return out;
}

/** Docs: "Any code besides 0 or null is a failure." */
function hasError(msg: SendblueMessage): boolean {
  return msg.error_code != null && msg.error_code !== 0 && msg.error_code !== '0';
}

function errorCodeOf(msg: SendblueMessage): string {
  // error_key is the documented stable identifier for rule declines (e.g. OPTED_OUT).
  if (msg.error_key) return msg.error_key;
  if (msg.error_code != null) return String(msg.error_code);
  return msg.status ?? 'UNKNOWN';
}

function errorMessageOf(msg: SendblueMessage): string | undefined {
  return msg.error_reason || msg.error_message || msg.error_detail || undefined;
}

function isPermanentFailure(msg: SendblueMessage): boolean {
  // DECLINED = rejected by a rule (opt-out, pre-reply limits); resending the same message won't pass.
  if (msg.status === 'DECLINED' || msg.opted_out) return true;
  return msg.error_code != null && PERMANENT_ERROR_CODES.has(String(msg.error_code));
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
