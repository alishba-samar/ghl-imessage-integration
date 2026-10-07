# POC live test plan

This checklist proves the iMessage integration works end to end with real GoHighLevel (GHL), real Sendblue and a real phone:

> GHL workflow → iMessage sent via Sendblue → "delivered" shown in GHL → customer replies → reply shows in GHL Conversations → contact tagged `imessage-replied` → follow-up workflow stops

It also covers a manual send from the GHL inbox, a failed message, and a STOP opt-out. Allow about 45 minutes.

## How to check results

Every step says what to look for in three places:

- **GHL**: the sub-account's **Conversations** page and the contact's record (tags), plus the workflow's **Execution Logs**.
- **Database**: run `npm run db:studio` in the project folder. A browser tab opens. Click the **Message** table and sort by `createdAt` (newest first). **Suppression** and **Integration** are the other tables you'll need.
- **Server logs**: the terminal window running the server. Each line starts with a time and a level (`INFO`, `WARN`, `ERROR`) followed by a message, e.g. `INFO: Inbound message saved`. The step tells you which messages to look for. `WARN` or `ERROR` lines that this plan doesn't mention are worth reporting.

Write down the result of each test in the [results sheet](#results-sheet) at the end.

## Before you start

Tick every item. If one fails, fix it first. Most "it doesn't work" problems come from this list.

- [ ] **Tunnel running.** The Cloudflare tunnel window is open and shows a URL like `https://something.trycloudflare.com`. Below, this is called **TUNNEL**. The URL changes every time the tunnel restarts.
- [ ] **`PUBLIC_BASE_URL` matches the tunnel.** In the project's `.env` file, `PUBLIC_BASE_URL` is exactly TUNNEL (no trailing `/`). If you change it, restart the server.
- [ ] **Server running.** Open `TUNNEL/health` in a browser. You must see `{"ok":true,"db":"connected"}`.
- [ ] **Server settings.** In `.env`: `IMESSAGE_PROVIDER=sendblue`; `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER` and `SENDBLUE_WEBHOOK_SECRET` are filled in; `GHL_CONVERSATION_PROVIDER_ID` is filled in; `LOG_LEVEL=info`.
- [ ] **Sendblue webhooks match the tunnel.** Ask the developer to confirm (or check via the Sendblue API, `GET /api/account/webhooks`):
  - receive → `TUNNEL/webhooks/imessage/inbound`
  - outbound → `TUNNEL/webhooks/imessage/status`
  - global secret = `SENDBLUE_WEBHOOK_SECRET`
- [ ] **GHL Delivery URL matches the tunnel.** In the GHL Marketplace app → Conversation Providers, the Delivery URL is `TUNNEL/webhooks/ghl/outbound-imessage`.
- [ ] **App installed on the test sub-account.** In Prisma Studio, the **Integration** table has a row whose `locationId` is your sub-account's ID and whose `conversationProviderId` is filled in. If not, install the app (see [Installing the app](#installing-the-app)).
- [ ] **Test phone ready.** An iPhone with iMessage turned on. A GHL contact exists with that phone number. On Sendblue's free/shared plan, this phone must have texted your Sendblue number once (verification).
- [ ] **Unique campaign ID.** Each run of Test 1 needs a new `campaignId` (e.g. `poc-run-1`, then `poc-run-2`). The server sends each campaign step to a contact **only once ever**, so reusing an ID means nothing is sent.

### Installing the app

1. Open the app's installation link from the GHL Marketplace and choose the test sub-account.
2. GHL sends your browser to `https://example.com/oauth/callback?code=...`. That page is not ours, which is expected.
3. Quickly (the code expires within minutes) copy everything after `code=` from the address bar and open `TUNNEL/oauth/callback?code=PASTE_CODE_HERE`.
4. You should see **"App installed"**. Server log: `INFO: GHL app installed`. Database: an **Integration** row for your `locationId`.

## Test 1: Workflow → delivered → reply → tagged → follow-up stops

### One-time setup: build the test workflow in GHL

Create a workflow (names in GHL's UI may differ slightly):

1. **Trigger:** *Contact Tag Added* → tag `poc-test-start`.
2. **Add Tag:** `imessage-campaign-active`.
3. **Custom Webhook** (first message):
   - Event: **CUSTOM**, Method: **POST**, Content-Type: `application/json`
   - URL: `TUNNEL/api/ghl/workflow/send-imessage`
   - Header: `x-api-key` = the `INTERNAL_API_KEY` value from `.env`
   - Body:
     ```json
     { "locationId": "{{location.id}}", "contactId": "{{contact.id}}", "phone": "{{contact.phone}}",
       "message": "Hi {{contact.first_name}}, this is our iMessage test. Please reply 'test reply'.",
       "campaignId": "poc-run-1", "campaignStep": "1" }
     ```
4. **Wait:** 5 minutes.
5. **If/Else:** contact **has tag** `imessage-replied`?
   - **Yes:** end the workflow (no further action).
   - **No:** another **Custom Webhook**, same as step 3 but with `"message": "Just following up..."` and `"campaignStep": "2"`.

### Step 1.1: Start the workflow

**Do:** add the tag `poc-test-start` to the test contact.

| Where | Expect |
|---|---|
| Phone | The iMessage arrives within ~30 seconds, as a **blue** bubble. |
| GHL | Workflow Execution Log: the Custom Webhook step succeeded (HTTP 200). Conversations: the message appears on the contact, in the iMessage channel. |
| Database (Message) | A new row: `direction` = OUTBOUND, `idempotencyKey` = `<locationId>-<contactId>-poc-run-1-1`, `campaignStep` = 1, and `ghlMessageId`, `conversationId`, `providerMessageId` and `dispatchedAt` all filled in. `status` = QUEUED or SENT. |
| Server logs | `Workflow message sent via GHL` (or `GHL Delivery arrived before the send response; merged…`, which is also fine), `Sendblue message submitted`, `Outbound iMessage processed`. |

If the bubble is **green**, or `service` = `sms` in the database, Sendblue sent it as SMS because it couldn't reach the phone via iMessage. The rest of the test still works, but check that iMessage is on.

### Step 1.2: Delivered status reaches GHL

**Do:** wait about a minute. Don't reply yet.

| Where | Expect |
|---|---|
| GHL | The message shows as **delivered** in Conversations. |
| Database (Message) | Same row: `status` = DELIVERED, `service` = imessage, `sentAt` and `deliveredAt` filled in. |
| Server logs | `Message status updated` (to: "DELIVERED"), then `GHL message status updated` (status: "delivered"). |

### Step 1.3: Reply from the phone

**Do:** reply `test reply` from the phone, within the 5-minute wait.

| Where | Expect |
|---|---|
| GHL | The reply appears in the contact's conversation. Contact tags: **`imessage-replied` added**, **`imessage-campaign-active` removed**. |
| Database (Message) | A new row: `direction` = INBOUND, `body` = test reply, `status` = DELIVERED, `phone` = the test phone, same `locationId` and `contactId` as the sent message, `ghlMessageId` and `conversationId` filled in. |
| Server logs | `Inbound message saved`, `Inbound message added to GHL`, `GHL contact tags added`, `GHL contact tags removed`. |

### Step 1.4: The follow-up does not send

**Do:** wait until the workflow's 5-minute wait is over.

| Where | Expect |
|---|---|
| Phone | **No** "Just following up..." message. |
| GHL | Execution Log: the If/Else took the **Yes** branch and the workflow ended. |
| Database (Message) | **No** row with `campaignStep` = 2 for this contact and `poc-run-1`. |
| Server logs | No new `Workflow message sent via GHL`. |

**Optional control run:** change `campaignId` to `poc-run-2` in **both** webhook steps, start the workflow again and **don't reply**. The follow-up **should** arrive after 5 minutes (a row with `campaignStep` = 2).

## Test 2: Manual send from the GHL Conversations inbox

**Do:** in GHL Conversations, open the test contact, pick the **iMessage** channel in the message box, type `Manual test` and send.

| Where | Expect |
|---|---|
| Phone | The message arrives (blue bubble). |
| GHL | The message shows as pending, then **delivered**. |
| Database (Message) | A new OUTBOUND row where `idempotencyKey` and `ghlMessageId` are the same value, `campaignId` is empty, `status` goes to DELIVERED. |
| Server logs | `Sendblue message submitted`, `Outbound iMessage processed`, then `Message status updated` and `GHL message status updated`. |

Warning sign: `GHL webhook rejected: invalid signature` means the request didn't come from GHL or was changed on the way. Report it.

## Test 3: Failed message

**Do:** create a second GHL contact with a real, valid mobile number that **cannot** receive from your Sendblue line. On the free/shared plan, use a phone that has **never** texted your Sendblue number. Send `Failure test` to it from the Conversations inbox (iMessage channel).

| Where | Expect |
|---|---|
| GHL | The message is marked **failed**. |
| Database (Message) | The row has `status` = FAILED, `failedAt` filled in, and an `errorCode` and `errorMessage` explaining why. |
| Server logs | Either `Sendblue send-message failed` (rejected straight away) or, a little later, `Message status updated` (to: "FAILED"). Then `GHL message status updated` (status: "failed"). |

If the message is delivered after all, the number was reachable. Pick another one.

**Also check bad input:** start the Test 1 workflow for a contact whose phone is clearly invalid (e.g. `123`). The Custom Webhook step shows **HTTP 400** with `INVALID_PHONE`. Nothing is sent, no Message row is created, and nothing appears in Conversations.

## Test 4: STOP opt-out (do this last)

This blocks the test phone from further messages until you undo it (see the end of this test).

### Step 4.1: Reply STOP

**Do:** from the test phone, reply `STOP` in the iMessage thread.

| Where | Expect |
|---|---|
| GHL | The STOP reply appears in Conversations. Tags: **`imessage-optout`** and `imessage-replied` added, `imessage-campaign-active` removed. |
| Database | Message: an INBOUND row with `body` = STOP. **Suppression**: a new row with your `locationId`, the test `phone`, `reason` = STOP and the `contactId`. |
| Server logs | `Inbound message saved`, `Opt-out received; phone suppressed`, `Inbound message added to GHL`, `GHL contact tags added`. |

### Step 4.2: Sends are now blocked

**Do:** start the Test 1 workflow again with a **new** `campaignId` (e.g. `poc-run-stop`). Then also try a manual send from the inbox.

| Where | Expect |
|---|---|
| Phone | **Nothing** arrives. |
| GHL | Workflow Execution Log: the Custom Webhook step returns HTTP 200 with `"ok":false,"error":"SUPPRESSED"`. Manual send: the message is marked **failed**. |
| Database | No new OUTBOUND row from the workflow. |
| Server logs | Manual send: `GHL outbound message not sent` and `GHL message marked failed`. |

Known gap: STOP does **not** set Do Not Disturb on the GHL contact (see `docs/PRODUCTION_NOTES.md`).

### Undo the opt-out

In Prisma Studio, open **Suppression**, delete the row for the test phone and save. Remove the `imessage-optout` tag in GHL if you want a clean contact.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `TUNNEL/health` doesn't load | Tunnel or server stopped | Restart them. A new tunnel URL means updating `.env`, the Sendblue webhooks and the GHL Delivery URL. |
| Workflow webhook step shows 401 | Wrong `x-api-key` | Copy `INTERNAL_API_KEY` from `.env` again. |
| Workflow returns `GHL_NOT_CONNECTED` | App not installed, or no `conversationProviderId` | See [Installing the app](#installing-the-app). |
| Workflow returns `"duplicate":true` and nothing is sent | `campaignId` + `campaignStep` already used for this contact | Use a new `campaignId`. |
| Message stays "pending" in GHL, no server log lines | GHL Delivery URL points at an old tunnel | Update the Delivery URL. |
| Log: `GHL webhook rejected: invalid signature` | Request not from GHL | Check the Delivery URL. Report it if it persists. |
| Message sent, but status never reaches DELIVERED | Sendblue outbound webhook not pointing at the tunnel | Re-check the Sendblue webhooks. |
| Log: `Webhook rejected: bad or missing signing secret` | Sendblue global secret ≠ `SENDBLUE_WEBHOOK_SECRET` | Re-set the Sendblue webhooks with the right secret. |
| Reply is in the database but not in GHL | Integration has no `conversationProviderId`, or a GHL error | Look for `No conversationProviderId…` or `Failed to add inbound message to GHL` in the logs. |
| Reply saved with `locationId` = unknown | We never messaged that phone (or only before this version) | Send from the workflow first, then reply. |
| Green bubble / `service` = sms | Sendblue fell back to SMS | Check iMessage is on for that phone. |
| Log: `GHL token refresh failed` | GHL connection expired or revoked | Reinstall the app. |

## Results sheet

Live run on **2026-10-07** (05:17–05:32 UTC) against the Railway server, using only the GHL contact **"Failure Test"** (own number, unverified on the Sendblue sandbox, so real sends to it fail). The TL's number was not messaged. **REAL** = a real call to GHL, Sendblue or our live server; **SIMULATED** = we played the customer's phone by posting a correctly signed Sendblue-format webhook to the live server.

| Test | Pass / Fail | Notes (time, what you saw) |
|---|---|---|
| Before you start: all items ticked | Partly | REAL: Railway `/health` OK; Sendblue webhooks and GHL Delivery URL point at Railway; app installed (agency install, provider id set). Not verified: the workflow's Custom Webhook URL/key (see 1.1). |
| 1.1 Workflow sends the iMessage | **Blocked** | REAL: tag `imessage-test` added to Failure Test at 05:25 UTC; the "iMessage POC Test" workflow produced **no processed request** on our server within 6 min (no message row, no "Workflow message sent via GHL" log). Rejected requests (401/400) aren't logged by the app, so check the workflow's Execution Log in GHL. |
| 1.2 Delivered status shown in GHL | Not possible on sandbox | Needs a verified/real phone (TL). REAL failure statuses do reach GHL (see 3). |
| 1.3 Reply in GHL + tags updated | **Pass** (after fix) | SIMULATED reply, REAL GHL writes. First run (05:18) failed to insert into GHL: `Incorrect conversationProviderId/type`; fixed (`type: "Custom"`, commit d350a96, deployed 05:24). Re-run 05:24: reply in the contact's conversation (inbound, our provider), `imessage-replied` added, `imessage-campaign-active` removed. |
| 1.4 Follow-up does not send | **Blocked** | Depends on 1.1. |
| 1 (optional) Control run: follow-up sends without reply | **Blocked** | Depends on 1.1. |
| 2 Manual inbox send delivered | Partly | REAL: a send through GHL's Send Message API (05:21) reached our Delivery URL, was sent to Sendblue and marked failed in GHL. "Delivered" needs a verified/real phone (TL). |
| 3 Failed message marked failed in GHL | **Pass** | REAL: GHL shows failed; our row has Sendblue's own reason: "This contact must be verified before sending messages to it." |
| 3 Invalid phone rejected (400) | Not run live | Covered by automated tests. |
| 4.1 STOP → suppressed + `imessage-optout` tag | **Pass** | SIMULATED "STOP" (05:31), REAL effects: suppression row (reason STOP), `imessage-optout` + `imessage-replied` added, STOP shown in GHL. |
| 4.2 Sends blocked after STOP | **Pass** | REAL calls to the live server: workflow route → `SUPPRESSED`, `/api/imessage/send` → 409; no message row, nothing sent to GHL/Sendblue. Afterwards the suppression row and test tags were removed (contact clean). |
| Wrong webhook secret rejected | **Pass** | SIMULATED inbound with a wrong `sb-signing-secret` (05:17) → 401, nothing saved, logged "Webhook rejected". |

### Still needed

- **Workflow run (1.1, 1.4, control run):** check the "iMessage POC Test" workflow's Execution Log in GHL for the 05:25 UTC enrollment of Failure Test: trigger (tag `imessage-test`), published, re-entry allowed, Custom Webhook URL = `https://ghl-imessage-integration-production.up.railway.app/api/ghl/workflow/send-imessage`, `x-api-key` = current `INTERNAL_API_KEY`. If the body has a fixed `campaignId`, each new run for the same contact needs a new value (a reused campaign step is treated as a duplicate and not sent).
- **TL (verified/real iPhone):** a real reply from a phone, a blue-bubble iMessage, and "Delivered" status in GHL. The Sendblue sandbox only messages verified contacts.
