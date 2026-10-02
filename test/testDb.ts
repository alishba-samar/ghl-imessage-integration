import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

export interface TestDbUrls {
  runtime: string;
  direct: string;
}

/**
 * Reads TEST_DATABASE_URL / TEST_DIRECT_URL (from the environment or .env) and refuses to continue if
 * either is missing or points at the real database (DATABASE_URL / DIRECT_URL). Tests truncate tables,
 * so running them against the real database would destroy data.
 */
export function getTestDbUrls(): TestDbUrls {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parse(readFileSync(resolve(__dirname, '..', '.env')));
  } catch {
    // no .env: rely on the process environment (e.g. CI)
  }
  const get = (key: string) => process.env[key] ?? fileEnv[key];

  const runtime = get('TEST_DATABASE_URL');
  const direct = get('TEST_DIRECT_URL');
  // The real URLs are read only to compare against; they are never used by the tests.
  const real = [fileEnv.DATABASE_URL, fileEnv.DIRECT_URL].filter(Boolean);

  const fail = (msg: string): never => {
    throw new Error(`\n\n  Refusing to run tests: ${msg}\n  Set TEST_DATABASE_URL and TEST_DIRECT_URL (a separate, disposable database) in .env.\n`);
  };
  if (!runtime) fail('TEST_DATABASE_URL is not set.');
  if (!direct) fail('TEST_DIRECT_URL is not set.');
  if (real.includes(runtime!)) fail('TEST_DATABASE_URL is the same as DATABASE_URL / DIRECT_URL.');
  if (real.includes(direct!)) fail('TEST_DIRECT_URL is the same as DATABASE_URL / DIRECT_URL.');
  if (hostAndDb(runtime!) && real.some((u) => hostAndDb(u) === hostAndDb(runtime!) || hostAndDb(u) === hostAndDb(direct!))) {
    fail('the test database points at the same host and database as DATABASE_URL / DIRECT_URL.');
  }
  return { runtime: runtime!, direct: direct! };
}

/** "host/db" ignoring Neon's "-pooler" suffix, so pooled and direct URLs of one database compare equal. */
function hostAndDb(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.hostname.replace('-pooler', '')}${u.pathname}`;
  } catch {
    return undefined;
  }
}
