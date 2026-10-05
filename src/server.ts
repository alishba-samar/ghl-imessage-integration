import { createApp } from './app';
import { prisma } from './config/db';
import { env } from './config/env';
import { drainBackgroundTasks } from './utils/background';
import { logger } from './utils/logger';

const app = createApp();

// PORT is set by the host (e.g. Render); bind to all interfaces so the platform's proxy can reach us.
const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`Server listening on port ${env.PORT}${env.PUBLIC_BASE_URL ? ` (${env.PUBLIC_BASE_URL})` : ''}`);
});

// Hosts send SIGTERM on deploys and (Render free plan) when the instance spins down. Stop accepting
// connections, let background work (GHL syncs, Delivery URL sends) finish, then exit.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out; exiting');
    process.exit(1);
  }, 25_000);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await drainBackgroundTasks();
  await prisma.$disconnect();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
