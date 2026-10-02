import { logger } from './logger';

const pending = new Set<Promise<void>>();

/**
 * Runs work after the current request has been answered (e.g. syncing to GHL after acknowledging a webhook).
 * Errors are logged, never thrown. In-process only: work is lost if the process exits before it finishes.
 */
export function runInBackground(name: string, work: () => Promise<void>): void {
  const task = Promise.resolve()
    .then(work)
    .catch((err) => logger.error({ err, task: name }, 'Background task failed'))
    .finally(() => pending.delete(task));
  pending.add(task);
}

/** Resolves once all background tasks started so far (and any they start) have finished. */
export async function drainBackgroundTasks(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
