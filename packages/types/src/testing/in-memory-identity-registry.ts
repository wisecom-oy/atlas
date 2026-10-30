import type { IdentityRegistry } from '../domain/identity-registry';
import type {
  IdentityRegistryMutation,
  IdentityRegistryRepository,
} from '../ports/identity/identity-registry-repository.port';

/**
 * An identity registry repository holding one registry in memory with compare-and-swap semantics.
 *
 * `before_write` runs between a read and the conditional write, which is where a test injects a
 * competing writer to prove an update is re-applied rather than lost.
 */
export class InMemoryIdentityRegistryRepository implements IdentityRegistryRepository {
  stored: IdentityRegistry | undefined;
  writes = 0;
  conflicts = 0;
  before_write: (() => void) | undefined;
  private _version = 0;

  constructor(initial?: IdentityRegistry) {
    this.stored = initial;
  }

  /** Returns the stored registry. */
  async load(): Promise<IdentityRegistry | undefined> {
    return this.stored;
  }

  /** Applies `mutate`, retrying when the stored version moved between read and write. */
  async update(
    _ctx: unknown,
    mutate: IdentityRegistryMutation,
  ): Promise<IdentityRegistry | undefined> {
    for (;;) {
      const read_version = this._version;
      const next = mutate(this.stored);
      if (next === undefined) return this.stored;
      await Promise.resolve();
      this.before_write?.();
      if (this._version !== read_version) {
        this.conflicts++;
        continue;
      }
      this.replace(next);
      return next;
    }
  }

  /** Overwrites the stored registry as another writer would, bumping its version. */
  replace(registry: IdentityRegistry): void {
    this.stored = registry;
    this._version++;
    this.writes++;
  }
}
