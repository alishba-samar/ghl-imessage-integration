// Runs in every test worker before any test file is imported. It must not statically import app code:
// src/config/env.ts parses process.env on import, so the test values below have to be in place first.
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { ghlServer } from './helpers/ghl';
import { getTestDbUrls } from './testDb';

const testDb = getTestDbUrls();
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent', // e.g. TEST_LOG_LEVEL=debug npm test
  // Database: the test database only. dotenv never overrides variables that are already set.
  DATABASE_URL: testDb.runtime,
  DIRECT_URL: testDb.direct,
  // Test-only secrets; the real values in .env are never loaded.
  INTERNAL_API_KEY: 'test-internal-api-key-0123456789',
  SENDBLUE_WEBHOOK_SECRET: 'test-sendblue-webhook-secret',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  GHL_CLIENT_ID: 'test-ghl-client-id',
  GHL_CLIENT_SECRET: 'test-ghl-client-secret',
  GHL_CONVERSATION_PROVIDER_ID: 'test-provider-id',
  GHL_WEBHOOK_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  TEST_GHL_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  PUBLIC_BASE_URL: 'https://test.example',
  GHL_OAUTH_REDIRECT_URI: '', // default: PUBLIC_BASE_URL + /oauth/callback (a test overrides it)
  // External providers: mock only. Blank (not unset) so dotenv can't fill in the real credentials.
  IMESSAGE_PROVIDER: 'mock',
  SENDBLUE_API_KEY: '',
  SENDBLUE_API_SECRET: '',
  SENDBLUE_FROM_NUMBER: '',
});

let prisma: typeof import('../src/config/db').prisma;
let drainBackgroundTasks: typeof import('../src/utils/background').drainBackgroundTasks;

beforeAll(async () => {
  ({ prisma } = await import('../src/config/db'));
  ({ drainBackgroundTasks } = await import('../src/utils/background'));
  const { env } = await import('../src/config/env');
  // Belt and braces: the app's parsed config must point at the test database before anything is truncated.
  if (env.DATABASE_URL !== testDb.runtime) throw new Error('App is not configured with TEST_DATABASE_URL; aborting.');
  ghlServer.listen({
    // Anything not handled by the GHL stub must be a request to our own app (supertest); fail everything else.
    onUnhandledRequest(request, print) {
      const host = new URL(request.url).hostname;
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return;
      print.error();
    },
  });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Message", "Suppression", "Integration", "Sender" RESTART IDENTITY CASCADE');
});

afterEach(async () => {
  await drainBackgroundTasks();
  const { ghl } = await import('./helpers/ghl');
  ghl.reset();
});

afterAll(async () => {
  ghlServer.close();
  await prisma.$disconnect();
});
