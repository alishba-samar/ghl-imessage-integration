import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { env } from './env';

// Opening a connection to Neon costs ~2s (TLS + round trips), so keep idle connections around longer than
// pg's 10s default, allow slow connects, and use TCP keepalive so dropped connections are detected.
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
});

export const prisma = new PrismaClient({
  adapter,
  // Prisma's default maxWait (2s) to start an interactive transaction is too short when a new connection to a
  // remote database (Neon) must be opened first; it surfaced as P2028 errors in tests.
  transactionOptions: { maxWait: 10_000, timeout: 15_000 },
});

/** True for a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
