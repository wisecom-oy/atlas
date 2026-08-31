import type { Container } from 'inversify';
import type { StorageDisposer } from '@wisecom/atlas-types';
import { STORAGE_DISPOSER_TOKEN } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Builds the teardown for one Atlas instance.
 *
 * Storage releases first, since it owns the keep-alive sockets and the cached
 * bucket state, then the container bindings that hold everything else. What
 * "storage releases" means is the adapter's business, reached through
 * `STORAGE_DISPOSER_TOKEN` rather than by importing it.
 *
 * Idempotent, because a `dispose()` in a `finally` block and an `await using`
 * scope can both fire. Each step is guarded on its own: a failure to close
 * sockets must not leave the container bound, or a service disposing per
 * request leaks exactly as before (issue #42).
 */
export function create_disposer(container: Container): () => Promise<void> {
  let disposed = false;

  return async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;

    await release(async () => {
      if (!container.isBound(STORAGE_DISPOSER_TOKEN)) return;
      await container.get<StorageDisposer>(STORAGE_DISPOSER_TOKEN)();
    }, 'storage');

    await release(() => container.unbindAll(), 'container bindings');
  };
}

/** Runs one teardown step, reporting rather than aborting the rest. */
async function release(step: () => Promise<void>, what: string): Promise<void> {
  try {
    await step();
  } catch (err) {
    logger.warn(`Failed to release ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
