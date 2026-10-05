# Deploying to Render

How to run this backend as a Render **Web Service** (free instance) using the existing Neon database.

## 1. Create the web service

In Render: **New → Web Service → Build and deploy from a Git repository**, pick `alishba-samar/ghl-imessage-integration`, then:

| Setting | Value |
|---|---|
| Name | e.g. `ghl-imessage` (the URL becomes `https://<name>.onrender.com`) |
| Region | **Ohio (US East)**: closest to the Neon database (AWS us-east-2). Every query is a network round trip, so this matters a lot. |
| Branch | `main` |
| Runtime | **Node** (version comes from `"engines": { "node": "22.x" }` in `package.json`) |
| Root directory | *(empty)* |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Instance type | **Free** |
| Health check path | `/health` (Advanced settings) |
| Auto-deploy | On commit (default) |

**Why `--include=dev`:** with `NODE_ENV=production`, `npm ci` skips devDependencies, but the build needs `typescript` and `prisma` (to generate the Prisma client). `npm run build` = `prisma generate && tsc`, and `npm start` = `node dist/server.js`.

The server listens on `PORT` (Render sets it; don't set it yourself) on `0.0.0.0`, and shuts down gracefully on `SIGTERM` (deploys, spin-down): it stops accepting requests and finishes background work (GHL syncs, Delivery URL sends) before exiting.

Verified locally on 2026-10-05: a clean copy of the repo **without `.env`**, with `NODE_ENV=production`, built with that build command, started with `npm start` on port 10000; `/health` returned `{"ok":true,"db":"connected"}`, the dev-only route was off, and `SIGTERM` shut it down cleanly.

## 2. Environment variables

Set these under **Environment** before the first deploy.

### Copy exactly from your local `.env`

| Variable | Note |
|---|---|
| `DATABASE_URL` | The **pooled** Neon URL (host contains `-pooler`). |
| `TOKEN_ENCRYPTION_KEY` | **Must be identical to local.** GHL tokens in the database were encrypted with it; a different key makes them unreadable and every location has to reinstall the app. |
| `INTERNAL_API_KEY` | Used by `/api/imessage/send` and the GHL workflow Custom Webhook (`x-api-key`). |
| `IMESSAGE_PROVIDER` | `sendblue` |
| `SENDBLUE_API_KEY` | |
| `SENDBLUE_API_SECRET` | |
| `SENDBLUE_FROM_NUMBER` | |
| `SENDBLUE_WEBHOOK_SECRET` | Must match the `globalSecret` on the Sendblue webhooks. **Required in production**: without it every Sendblue webhook is rejected. |
| `GHL_CLIENT_ID` | |
| `GHL_CLIENT_SECRET` | |
| `GHL_CONVERSATION_PROVIDER_ID` | |
| `GHL_OAUTH_REDIRECT_URI` | Currently `https://example.com/oauth/callback`. See step 5 for switching to the Render URL. |

Only if you've set them locally: `GHL_APP_ID`, `GHL_API_VERSION`, `GHL_WEBHOOK_PUBLIC_KEY`, `SENDBLUE_BASE_URL`.

### Set new values on Render

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | The Render URL, e.g. `https://ghl-imessage.onrender.com` (no trailing `/`) |
| `LOG_LEVEL` | `info` (`debug` logs phone numbers and message text; don't leave it on) |

### Do NOT set on Render

| Variable | Why |
|---|---|
| `PORT` | Render sets it; overriding it breaks routing. |
| `DIRECT_URL` | Only used by the Prisma CLI for migrations, which run from your machine (step 3). |
| `TEST_DATABASE_URL`, `TEST_DIRECT_URL` | Tests only; Render doesn't run the tests. |

## 3. Database migrations

The main Neon database is already fully migrated. The app doesn't migrate on startup, and the free plan has no pre-deploy command, so **run migrations from your machine before deploying code that needs them**:

```
npm run db:deploy
```

This runs `prisma migrate deploy` against `DIRECT_URL` in your local `.env` (the main database's direct connection). The order for a schema change:

1. Create the migration locally (`npm run db:migrate`), test it, commit it.
2. Run `npm run db:deploy` to apply it to the main database.
3. Push to `main`; Render deploys the new code.

Keep migrations backward compatible (add columns/tables, don't rename or drop in the same release), so the code still running on Render keeps working between steps 2 and 3. On a paid plan you could instead set the **pre-deploy command** to `npx prisma migrate deploy` with `DIRECT_URL` added to Render's environment.

## 4. First deploy and check

1. Click **Create Web Service** and wait for the build and deploy to finish ("Live").
2. Open `https://<your-service>.onrender.com/health`. You must see `{"ok":true,"db":"connected"}`.
3. In Render's **Logs** tab, look for `Server listening on port ...` (logs are JSON in production).

## 5. Switch traffic from the tunnel to Render

Do these together, in this order:

1. **Stop the local server and the Cloudflare tunnel.** Both servers use the same database; if both stay up and receive the same webhooks, messages and statuses can be processed twice. From now on, only Render should run.
2. **Sendblue webhooks** → Render URL (via `PUT /api/account/webhooks`, as before; the dashboard fails to save):
   - receive → `https://<your-service>.onrender.com/webhooks/imessage/inbound`
   - outbound → `https://<your-service>.onrender.com/webhooks/imessage/status`
   - `globalSecret` = `SENDBLUE_WEBHOOK_SECRET`
3. **GHL Marketplace app**:
   - Conversation provider **Delivery URL** → `https://<your-service>.onrender.com/webhooks/ghl/outbound-imessage`
   - App **Webhook URL** (App Install events) → `https://<your-service>.onrender.com/webhooks/ghl/app`
4. **GHL workflows**: update each Custom Webhook action URL to `https://<your-service>.onrender.com/api/ghl/workflow/send-imessage`.
5. **Optional, recommended:** the Render URL doesn't change, so it can be the real OAuth Redirect URL. Add `https://<your-service>.onrender.com/oauth/callback` as a Redirect URL in the GHL app, then **delete** `GHL_OAUTH_REDIRECT_URI` on Render (it then defaults to `PUBLIC_BASE_URL/oauth/callback`). Installs then complete without copying the code from example.com. Existing tokens keep working; only new installs and refreshes use the new redirect URI, so register it in GHL first.
6. Run `docs/POC_TEST_PLAN.md` against the Render URL (use it wherever the plan says TUNNEL).

## 6. Free instance limitations

- **Spins down after ~15 minutes without traffic.** The next request waits while it starts again (up to about a minute). Sendblue waits 45s per webhook and retries; GHL retries failed deliveries up to 12 times; a GHL workflow Custom Webhook may simply fail during a cold start. For testing, an external uptime monitor pinging `/health` every 10 minutes keeps it awake (this also keeps the Neon database awake, which uses Neon compute hours). For production, use a paid instance.
- **In-memory background work** (GHL syncs, Delivery URL sends after we answer 200) survives normal deploys and spin-downs thanks to the graceful shutdown, but is lost on a crash. See `docs/PRODUCTION_NOTES.md`.
- **Every push to `main` deploys.** Run `npm test` before pushing.
