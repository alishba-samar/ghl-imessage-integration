import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getTestDbUrls } from './testDb';

/** Runs once before the whole suite: verify the test database, then apply migrations to it. */
export default function setup(): void {
  const { runtime, direct } = getTestDbUrls();

  // prisma.config.ts reads DIRECT_URL; point it (and DATABASE_URL) at the test database for this command only.
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DATABASE_URL: runtime, DIRECT_URL: direct },
  });
}
