import type { GraphServicePool, ThrottleCoordinator } from '@wisecom/atlas-types';
// Relative, like its siblings: m365-graph's tests load this file from source, where core's `@/` alias does not resolve.
import { ThrottleFence } from './throttle-fence';

/**
 * The default {@link ThrottleCoordinator}: one {@link ThrottleFence} per Graph throttling pool,
 * held in memory and shared by every operation of one Atlas instance.
 *
 * Per pool because Graph meters the pools separately. A SharePoint 429 says nothing about the
 * Outlook budget, so it must not pause a mailbox backup running beside the drive backup.
 */
export class InProcessThrottleCoordinator implements ThrottleCoordinator {
  private readonly _fences = new Map<GraphServicePool, ThrottleFence>();

  /** Resolves once no cooldown is active for `pool`. */
  async wait(pool: GraphServicePool): Promise<void> {
    await this._fences.get(pool)?.wait();
  }

  /** Starts or extends the cooldown for `pool`. */
  raise(pool: GraphServicePool, retry_after_ms: number): void {
    this.fence_for(pool).raise(retry_after_ms / 1000);
  }

  /** True while a cooldown is in force for `pool`. */
  is_cooling(pool: GraphServicePool): boolean {
    return this._fences.get(pool)?.is_raised ?? false;
  }

  /** Drops every cooldown and releases all waiters; for shutdown. */
  clear(): void {
    for (const fence of this._fences.values()) fence.clear();
  }

  private fence_for(pool: GraphServicePool): ThrottleFence {
    let fence = this._fences.get(pool);
    if (!fence) {
      fence = new ThrottleFence();
      this._fences.set(pool, fence);
    }
    return fence;
  }
}
