# Production notes

Known gaps to resolve before production. One bullet per concern, with the suggested fix.

## Send flow

- **No dedup without an idempotency key.** The default key uses `Date.now()` when there's no `campaignStep`, so a retried manual send goes out twice. *Fix:* require callers to pass a stable key (e.g. GHL's message id) once GHL is integrated.
- **Rows can get stuck in `QUEUED`.** If the process dies between creating the row and recording the provider result, retries return the stuck record and never resend it. Since 2026-10-01 `dispatchedAt` tells the cases apart: `QUEUED` + no `dispatchedAt` was never sent (safe to dispatch); `dispatchedAt` set + no `providerMessageId` died mid-send (may or may not have gone out). *Fix:* a sweeper that dispatches the first kind and flags the second for review instead of resending.
- **Statuses depend on Sendblue's account-level `outbound` webhook.** We no longer send a per-message `status_callback`, so if that webhook is missing or misconfigured in the Sendblue dashboard, messages stay `QUEUED` forever. (`PUBLIC_BASE_URL` is no longer used for Sendblue.) *Fix:* check the webhook config as part of deployment, and poll `getMessageStatus` for `QUEUED` rows older than a few minutes as a fallback.
- **All sends use one sender number.** Sends use the provider default (`SENDBLUE_FROM_NUMBER`). *Fix:* pick the sender per location from the `Sender` table, respecting its daily/hourly limits.
- **Temporary API auth.** `/api/imessage/send` is protected by a single shared `INTERNAL_API_KEY`. *Fix:* replace with GHL auth (OAuth / signed requests).

## Webhooks

- **Opt-outs from unknown phones don't block anything.** They're stored under `locationId: "unknown"`, which no send checks. *Fix:* a cross-location suppression check, or a review queue for unlinked opt-outs.
- **Replies are linked by phone number only.** The most recent outbound message to that phone wins, so two locations messaging the same person can mislink replies. *Fix:* also match on the Sendblue line (`to` number), using the `Sender` table.
- **`isPermanentFailure` isn't stored.** It's only logged, so a retry job can't tell permanent from transient failures. *Fix:* add a column (or derive it from `errorCode`) before building retries.
- **Per-message `status_callback` requests carry no secret.** Observed 2026-10-01: Sendblue sent the callback without `sb-signing-secret`, even with a global secret configured, so it was rejected (401) and the status lost. *Resolved:* we no longer send `status_callback`; statuses come via the account-level `outbound` webhook. *Still to verify:* that the `outbound` webhook does carry the secret (confirm with the next real send).
- **Status timestamps are our processing time, not the provider's.** `sentAt` / `deliveredAt` / `failedAt` are set when we process the update, so delayed or retried webhooks skew them (e.g. sentAt 10:37:12 vs Sendblue's `date_sent` 10:33:49). *Fix:* add an optional `occurredAt` to `StatusUpdate`, filled from Sendblue's `date_updated`, and use it when present.
- **Webhook auth is a shared secret, not a signature.** Sendblue echoes the secret in `sb-signing-secret`; there's no HMAC over the body. *Fix:* always set `SENDBLUE_WEBHOOK_SECRET` in production (already enforced) and use HTTPS only.

## GHL OAuth

- **A refresh can be lost if saving fails.** GHL refresh tokens are single-use: if GHL returns new tokens but our DB write fails (or the process dies first), the old refresh token is already invalid and the location must reinstall. *Fix:* alert on `REFRESH_FAILED`, and show a "reconnect" state for that location rather than failing silently.
- **Refresh holds a DB transaction open during the HTTP call.** The row lock (needed so two server instances can't both refresh) lasts up to the 10s GHL timeout. *Fix:* fine at POC scale; at higher volume, refresh proactively in a background job instead of on request.
- **A revoked token isn't retried.** If GHL rejects a token before its expiry (e.g. after a reinstall), API calls fail with 401 until expiry. *Fix:* on a 401, force one refresh and retry the call once.
- **Agency (Company) installs aren't supported.** The callback only accepts Location tokens; bulk installs from an agency are rejected. *Fix:* store the Company token and mint Location tokens via `POST /oauth/locationToken`.
- **Install/uninstall webhooks aren't handled.** An uninstalled location keeps its Integration row and tokens. *Fix:* handle GHL's `INSTALL` / `UNINSTALL` app webhooks; delete tokens on uninstall.
- **No encryption key rotation.** Tokens are encrypted with one `TOKEN_ENCRYPTION_KEY`; losing or changing it forces every location to reinstall. *Fix:* keep the key in a secret manager with backups; the `v1:` prefix leaves room for multi-key rotation later.
- **`Version: v3` is unverified against the live API.** The current docs list `v3` as the only option, but older examples use `2021-07-28`. *Fix:* confirm with the first real install; it's one constant in `src/ghl/http.ts`.

## GHL Conversations

- **Background work is in-memory only.** GHL Delivery URL sends and all GHL syncs run after we've answered 200, so a crash or restart mid-task loses them, and GHL won't retry an acknowledged delivery. *Fix:* a durable queue/outbox table; meanwhile call `drainBackgroundTasks()` on SIGTERM.
- **Failed GHL syncs aren't retried.** If GHL is down, inbound replies stay only in our DB (`ghlMessageId` null) and status updates are dropped. *Fix:* a reconciliation job that re-syncs INBOUND rows without `ghlMessageId` and re-sends the latest status for GHL-originated messages.
- **`conversationProviderId` isn't set automatically.** GHL sync only runs when the location's Integration has it, and nothing fills it on install yet. *Fix:* set it in the OAuth callback from app config (env), since it's the same provider id for every location.
- **iMessage messages stay "pending" in GHL until DELIVERED.** GHL has no "sent" status; SENT over SMS maps to delivered, but SENT over iMessage sends no update, so if Sendblue never reports DELIVERED, GHL shows pending forever. *Fix:* after a timeout, poll `getMessageStatus` or mark delivered.
- **Only the first attachment is sent.** GHL can send several; Sendblue takes one `media_url` per message. *Fix:* send extra attachments as separate messages.
- **Reply contact matching may pick a different GHL contact.** Inbound replies look up the contact by phone (duplicate search, then upsert), which follows the location's duplicate settings and can differ from the contact we messaged. The duplicate-search response format is also undocumented. *Fix:* prefer the `contactId` of the outbound message being replied to when it's a GHL id.
- **Opt-outs aren't mirrored to GHL.** A STOP suppresses locally but doesn't set DND on the GHL contact or stop its workflow. *Fix:* set DND via the contacts API and stop the workflow (existing TODO).
- **No replay protection on the Delivery URL.** `X-GHL-Signature` covers only the body (no timestamp), so a captured request could be replayed. *Mitigated:* the GHL `messageId` is our idempotency key, so a replay can't send twice.
- **GHL error object `type` is omitted.** The Update message status `error` object's fields aren't fully documented; we send `code` and `message` only. *Fix:* confirm with a real failed message.

## GHL workflows

- **The workflow endpoint trusts the `locationId` in the body.** One shared `INTERNAL_API_KEY` sits in every location's workflow config, so anyone who can see it can send as any location, including ones that never installed the app. *Fix:* per-location API keys checked against `locationId`, or replace the Custom Webhook with a Marketplace workflow action (GHL-signed, location comes from GHL).
- **Workflow sends now go through GHL (resolved 2026-10-01).** `/api/ghl/workflow/send-imessage` reserves the step, calls GHL's Send a new message API with our `conversationProviderId`, and the Delivery URL does the one provider send. *Still to verify live:* that GHL calls the Delivery URL for API-originated messages (the docs list Workflows/Web App/Bulk Actions), and that `status: "pending"` (documented as required) is the right value.
- **A failed GHL send blocks that campaign step.** If the Send Message API errors, the reserved row is marked `GHL_SEND_FAILED` and repeats of the step are treated as duplicates, because GHL may have accepted the request despite the error (e.g. timeout) and retrying could double-send. *Fix:* a reconciliation job that checks GHL (Get message) before retrying such steps.
- **GHL may accept a message but never call the Delivery URL.** The row then stays `QUEUED` with a `ghlMessageId` and no `dispatchedAt`. *Fix:* the QUEUED sweeper above can dispatch it after a few minutes (the claim keeps it exactly-once even if the Delivery arrives late).
- **Workflow sends require a connected location.** Without an Integration that has a `conversationProviderId`, the endpoint returns `GHL_NOT_CONNECTED` and sends nothing (by design, so nothing is sent outside GHL Conversations).
- **A campaign step is sent at most once per contact, ever.** The key is `locationId-contactId-campaignId-campaignStep`, so a contact who re-enters the workflow later won't get that step again, and a changed phone number won't be messaged for a step already sent. *Fix:* include an enrollment/run id (e.g. workflow execution id or date) in `campaignId` when re-sends are wanted.
- **Custom Webhook retry behaviour is undocumented.** GHL's help docs don't say whether failed Custom Webhook calls are retried; a 5xx from us (e.g. DB down) may silently drop that campaign step. *Fix:* monitor 5xx on this route; a Marketplace workflow action would give defined behaviour.
- **Tags are applied to the contact found by phone.** Like inbound sync, tagging uses the phone lookup, which may not be the contact the workflow messaged (see "Reply contact matching" above).

## Infrastructure

- **Run the app in the same region as the database.** From the dev machine each Neon query takes ~250ms and a new connection ~2s, with occasional dropped connections ("Connection terminated unexpectedly"); this is what made the test suite need retries. *Fix:* deploy in AWS us-east-2 (or move the DB next to the app). The Prisma pool now keeps idle connections for 60s, allows 15s to connect, and gives interactive transactions 10s to start (the 2s default caused P2028 errors).
- **Transient DB errors surface as 500s.** We don't retry DB writes automatically (it could double-apply). Webhook senders retry (Sendblue 3x, GHL up to 12x) and our handlers are idempotent, but API callers must retry with the same idempotency key. *Fix:* document this for API/workflow callers; consider a retry wrapper for read-only queries.

## Logging

- **`LOG_LEVEL=debug` logs personal data.** Raw Sendblue responses include phone numbers and message content (never credentials). *Fix:* keep production at `info`; if debug is needed, enable it briefly and make sure log retention/access fits the data.

## Sendblue behaviour

- **iMessage silently falls back to SMS.** Sendblue downgrades non-iMessage recipients to SMS and this can't be disabled; it's only visible via `service` / `wasDowngraded`, and `was_downgraded` can be `null` even when `service` is `SMS` (observed 2026-10-01), so check `service`. *Fix:* if a flow must be iMessage-only, call `checkCapability` first (cache results: lookups are limited to 30/hour and 100/day per line).
- **`GET /api/status` doesn't match the docs.** The live API returns `{ "status": { "status": "SENT" }, "message_handle": ... }` with no service, `was_downgraded`, error fields or timestamps (handled since 2026-10-01). Polling therefore can't fill `service`, and `sentAt` becomes the time we polled. *Fix:* rely on status webhooks as the primary source; treat polling as a fallback only.
- **No `READ` status.** Sendblue never reports read receipts for outbound messages, so `readAt` stays empty. *Fix:* don't build GHL features that depend on read status for Sendblue.
