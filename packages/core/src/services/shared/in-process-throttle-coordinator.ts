import type { GraphServicePool, ThrottleCoordinator, ThrottleScope } from '@wisecom/atlas-types';
// Relative, like its siblings: m365-graph's tests load this file from source, where core's `@/` alias does not resolve.
import { ThrottleFence } from './throttle-fence';

/**
 * The default {@link ThrottleCoordinator}: one {@link ThrottleFence} per Graph throttling pool,
 * held in memory and shared by every operation of one Atlas instance.
 *
 * Per pool because Graph meters the pools separately. A SharePoint 429 says nothing about the
 * Outlook budget, so it must not pause a mailbox backup running beside the drive backup.
 *
 * Outlook is narrower still: Graph meters it per mailbox, so a cooldown raised for one owner
 * (`outlook:<ownerId>`) leaves every other mailbox running. A request without an owner uses the
 * pool-wide `outlook` fence, and every owner-scoped wait honours that fence too.
 */
export class InProcessThrottleCoordinator implements ThrottleCoordinator {
  private readonly _fences = new Map<string, ThrottleFence>();

  /** Resolves once no cooldown is active for `pool`, or for `scope` within it. */
  async wait(pool: GraphServicePool, scope?: ThrottleScope): Promise<void> {
    await this._fences.get(pool)?.wait();
    const owner_key = this.owner_key(pool, scope);
    if (owner_key !== undefined) await this._fences.get(owner_key)?.wait();
  }

  /** Starts or extends the cooldown for `pool`, or for `scope` within it. */
  raise(pool: GraphServicePool, retry_after_ms: number, scope?: ThrottleScope): void {
    this.fence_for(this.owner_key(pool, scope) ?? pool).raise(retry_after_ms / 1000);
  }

  /** True while a cooldown is in force for `pool`, or for `scope` within it. */
  is_cooling(pool: GraphServicePool, scope?: ThrottleScope): boolean {
    const owner_key = this.owner_key(pool, scope);
    return (
      (this._fences.get(pool)?.is_raised ?? false) ||
      (owner_key !== undefined && (this._fences.get(owner_key)?.is_raised ?? false))
    );
  }

  /** Drops every cooldown and releases all waiters; for shutdown. */
  clear(): void {
    for (const fence of this._fences.values()) fence.clear();
  }

  /**
   * The key of the per-mailbox fence an Outlook request is scoped to, or undefined when it has no
   * owner. Pool names hold no colon, so an owner key can never collide with a pool key.
   */
  private owner_key(pool: GraphServicePool, scope?: ThrottleScope): string | undefined {
    return pool === 'outlook' && scope?.ownerId !== undefined
      ? `${pool}:${scope.ownerId}`
      : undefined;
  }

  private fence_for(key: string): ThrottleFence {
    let fence = this._fences.get(key);
    if (!fence) {
      fence = new ThrottleFence();
      this._fences.set(key, fence);
    }
    return fence;
  }
}
