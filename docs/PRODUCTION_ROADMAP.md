# Production roadmap

What remains after the POC to reach the architecture in *GHL iMessage Campaign Automation* (the spec), in the order we recommend building it. Section numbers (§) refer to that spec. Operational and infrastructure concerns are tracked separately in `docs/PRODUCTION_NOTES.md`.

## POC scope (agreed with TL)

The POC proves one path end to end, plus basic failure/status handling:

| POC item | Status |
|---|---|
| GHL workflow sends an iMessage (through GHL Conversations, delivered by our Delivery URL) | Built |
| Delivered status shown back in GHL | Built |
| Customer reply appears in GHL Conversations | Built |
| Follow-up stops on reply (`imessage-replied` tag + If/Else in the GHL workflow) | Built; the GHL workflow exists |
| Basic failure/status handling (failed sends marked failed in GHL with the provider's reason) | Built |

Everything below is the **production phase**, to start after POC approval.

## Effort estimates

Rough, for one developer familiar with this codebase, in working days, **including** automated tests and a live check. They don't include GHL Marketplace review time or waiting on third parties (Sendblue plan changes, GHL app approval).

## Phase 1: Stop campaigns reliably (≈ 3–4 days)

What actually ends a campaign when the customer or a salesperson responds.

| Item | Spec | Effort | Notes |
|---|---|---|---|
| **"iMessage Received" custom workflow trigger**: fire a Marketplace custom trigger for every inbound iMessage | §4, §10, §11 | 2–3 d | Register the trigger in the Marketplace app; fire it from the inbound webhook (TODO in `webhookService.ts`). Lets WF03 assign owner, notify, move the opportunity. |
| **Human takeover**: tag `imessage-human-takeover` when staff reply manually | §16 | 0.5–1 d | Manual sends arrive at our Delivery URL with a `userId`; tag the contact there. Alternatively GHL's *User Replied* trigger (configuration only). |

## Phase 2: Failure handling (≈ 2–3 days)

| Item | Spec | Effort | Notes |
|---|---|---|---|
| **Classify failures + retries** for temporary failures: 60 s → 5 min → 30 min, max 3 attempts | §14 | 1.5–2 d | `isPermanentFailure` and `retryCount` already exist. Needs a durable scheduler (Phase 3 queue, or a DB-backed retry job as a first step). |
| **Permanent failure actions**: tags `imessage-failed` / `imessage-unavailable` | §8, §14 | 0.5–1 d | "iMessage Status = Unavailable" custom field comes with Phase 4. |

## Phase 3: Throughput and senders (≈ 7–9 days)

| Item | Spec | Effort | Notes |
|---|---|---|---|
| **Durable queue + worker**: replace in-memory background tasks | §20 | 3–4 d | e.g. pg-boss on the existing Postgres, or BullMQ with Redis on Railway. Also fixes lost background work on crash (see production notes). |
| **Rate limits**: per minute / hour / sender / day / global, configurable | §20 | 1.5–2 d | Enforced by the worker. |
| **Sender selection + management**: use the `Sender` table (add `sender_name`, `provider_sender_id`, `last_health_check`); senders API `GET/POST /api/imessage/senders`, `PATCH /api/imessage/senders/:id` | §6, §7, §27 | 2–3 d | Today every message uses `SENDBLUE_FROM_NUMBER`. Requires Sendblue lines per sender. |

## Phase 4: Capability check, custom fields, SMS fallback (≈ 4–5 days)

| Item | Spec | Effort | Notes |
|---|---|---|---|
| **iMessage capability check before sending**, with caching | §6 step 6, §8 | 1–1.5 d | `checkCapability()` exists but is unused. Sendblue limits lookups to 30/hour and 100/day per line, so cache results. `GET /api/imessage/capability/:phone`. |
| **GHL custom fields**: iMessage Status, Last Checked, Last Sent, Last Delivered, Last Reply, Sender; tag `imessage-active` | §8 | 1.5–2 d | Create the fields via the GHL API on install; update on each event. |
| **SMS fallback through GHL** when iMessage permanently fails and `fallbackSms` is allowed | §15 | 1.5–2 d | Send through GHL's default SMS provider, never both channels at once. Sendblue's own automatic SMS fallback can't be disabled; decide how the two interact. |

## Phase 5: Opt-out and compliance (≈ 3 days)

| Item | Spec | Effort | Notes |
|---|---|---|---|
| **Opt-out → GHL DND** and remove the contact from iMessage workflows | §17 | 1 d | Suppression and `imessage-optout` already work (TODO in `webhookService.ts`). |
| **Consent storage + pre-send compliance check**: `consent_source`, `consent_timestamp`, `consent_ip`, campaign/source; refuse sends without consent or with DND | §26 | 2 d | New columns/table and a check in the send flow. |

## Phase 6: Marketplace workflow action and API completeness (≈ 4–6 days)

| Item | Spec | Effort | Notes |
|---|---|---|---|
| **"Send iMessage" Marketplace workflow action** with the spec's fields (Contact ID, Phone, Message, Media URL, Campaign ID, Message Step, Fallback to SMS, Sender Account) | §5 | 3–4 d | Replaces the POC's Custom Webhook + shared `INTERNAL_API_KEY` (a known security gap: any location could send as any other). GHL signs the request, so location comes from GHL. |
| **Validate location and contact** on every send endpoint | §6 steps 2–3 | 0.5 d | Today only the workflow route checks the location is connected. |
| **Remaining endpoints**: `GET /api/imessage/message/:id` | §27 | 0.5–1 d | Capability and senders endpoints are covered in Phases 3–4. |
| Logging lifecycle: explicit `PROCESSING` state, sender and retry count in logs | §23 | 0.5 d | |

**Total: roughly 23–30 developer days (≈ 5–6 weeks for one developer)**, plus GHL Marketplace review time.

## GHL configuration (no code)

| Item | Spec |
|---|---|
| Build workflows WF01 Campaign Entry, WF02 iMessage Nurture, WF03 Incoming iMessage, WF04 Human Takeover, WF05 Opt Out, WF06 Delivery Failure (separate workflows, not one) | §28 |
| Campaign stop conditions: appointment booked, opportunity Won/Lost, DND enabled, max messages reached | §18 |
| Configurable message timing per campaign | §19 |
| Set the GHL app **Webhook URL** to `https://ghl-imessage-integration-production.up.railway.app/webhooks/ghl/app` (connects sub-accounts added later) | — |

## Launch prerequisites (from `docs/PRODUCTION_NOTES.md`)

- Dedicated Sendblue line/plan (the sandbox can only message verified contacts).
- Railway on a paid plan with a usage limit and alert.
- Stable OAuth redirect URL on our own domain (replaces the example.com workaround).
- Railway deploys from GitHub, or the documented `railway up` process.
- Scopes locked in a live Marketplace app version, including any added for triggers, actions and custom fields.

## Acceptance tests still to run live (§29)

| Area | Remaining |
|---|---|
| Sending | Campaign sends first iMessage, personalization, correct sender used |
| Replies | Reply stops campaign (POC), salesperson notified (Phase 1) |
| Manual | Manual response stops automation (Phase 1) |
| Failure | Non-iMessage number, provider downtime, retry logic (Phase 2), SMS fallback (Phase 4) |
| Opt-out | Another workflow cannot bypass suppression (live check) |

Already covered: manual send from GHL, delivery status, invalid number, duplicate requests, STOP suppression, invalid GHL signature, invalid provider webhook, OAuth refresh, token encryption (automated tests, and live where noted in `docs/POC_TEST_PLAN.md`).
