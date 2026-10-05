import 'dotenv/config';
import { z } from 'zod';

// Treats `KEY=` (empty) in .env the same as an unset variable.
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    // Public URL of this server, used to build provider callback URLs. Trailing slash removed.
    PUBLIC_BASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().transform((u) => u.replace(/\/+$/, '')).optional(),
    ),
    // Temporary POC auth for /api routes (x-api-key header). Replaced by GHL auth later.
    INTERNAL_API_KEY: z.string().min(16, 'INTERNAL_API_KEY must be at least 16 characters'),
    // GHL OAuth app credentials. Optional for now so the server starts without them;
    // /oauth/callback and token refresh fail with a clear error until they're set.
    GHL_CLIENT_ID: optionalString,
    GHL_CLIENT_SECRET: optionalString,
    // Marketplace app id, required by GET /oauth/installed-locations for agency installs. Defaults to the part of
    // GHL_CLIENT_ID before the first "-" (GHL client ids look like "<appId>-<suffix>").
    GHL_APP_ID: optionalString,
    // Redirect URL registered on the GHL app, sent as redirect_uri on token requests.
    // Defaults to PUBLIC_BASE_URL + "/oauth/callback".
    GHL_OAUTH_REDIRECT_URI: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
    // Our custom conversation provider's id (same for every location). Saved on the Integration at install.
    GHL_CONVERSATION_PROVIDER_ID: optionalString,
    // "Version" header for GHL API calls. The current docs list "v3" as the only option.
    GHL_API_VERSION: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('v3')),
    // Ed25519 public key (PEM) for X-GHL-Signature. Defaults to the key published in GHL's Webhook
    // Integration Guide; override only if GHL rotates it. Escaped newlines ("\n" as two characters) are accepted.
    GHL_WEBHOOK_PUBLIC_KEY: optionalString,
    // AES-256-GCM key for tokens at rest: 32 random bytes, base64-encoded.
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
    IMESSAGE_PROVIDER: z.enum(['mock', 'sendblue']).default('mock'),
    SENDBLUE_API_KEY: optionalString,
    SENDBLUE_API_SECRET: optionalString,
    SENDBLUE_FROM_NUMBER: optionalString,
    SENDBLUE_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().default('https://api.sendblue.com')),
    // Value Sendblue sends in the sb-signing-secret header on webhooks. Not enforced yet.
    SENDBLUE_WEBHOOK_SECRET: optionalString,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.IMESSAGE_PROVIDER !== 'sendblue') return;
    for (const key of ['SENDBLUE_API_KEY', 'SENDBLUE_API_SECRET', 'SENDBLUE_FROM_NUMBER'] as const) {
      if (!cfg[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when IMESSAGE_PROVIDER=sendblue`,
        });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
