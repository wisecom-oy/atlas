import type { ObjectStorage, StorageTarget, TenantContext } from '@/index';

/**
 * A StorageTarget stub that counts context lifecycle calls.
 *
 * `create_context` derives an EnvelopeKeyService from the target passphrase and
 * `destroy` is what zeroes that buffer, so a replication path that creates a
 * context without destroying it leaves key material in the heap until GC
 * happens to collect it (issue #200). Counting both sides is the only way to
 * assert the balance, and a stub that simply omitted `destroy` was how the
 * omission stayed invisible.
 */
export interface StubStorageTarget {
  readonly target: StorageTarget;
  readonly storage: ObjectStorage;
  /** Contexts handed out by `create_context`. */
  readonly created: () => number;
  /** Contexts whose `destroy` was called. */
  readonly destroyed: () => number;
}

export interface StubStorageTargetOptions {
  readonly target_id?: string;
  /** Bucket contents, keyed by object key. Mutated by `put`. Ignored when `storage` is given. */
  readonly objects?: Record<string, Buffer>;
  /**
   * Storage to hand to every context. Supply one when the test needs to assert
   * on storage calls, since this package cannot depend on a test framework and
   * so cannot hand out spies of its own.
   */
  readonly storage?: ObjectStorage;
  /** Thrown by `create_context` for failure-path tests. */
  readonly create_error?: Error;
}

/** Builds a counting StorageTarget stub over an in-memory bucket. */
export function stub_storage_target(options: StubStorageTargetOptions = {}): StubStorageTarget {
  const objects = options.objects ?? {};
  let created = 0;
  let destroyed = 0;

  const in_memory: ObjectStorage = {
    exists: async (key: string) => key in objects,
    get: async (key: string) => {
      const blob = objects[key];
      if (!blob) throw new Error(`missing ${key}`);
      return blob;
    },
    put: async (key: string, data: Buffer) => {
      objects[key] = data;
    },
    list: async (prefix: string, limit?: number) => {
      const matched = Object.keys(objects)
        .sort()
        .filter((k) => k.startsWith(prefix));
      return limit === undefined ? matched : matched.slice(0, limit);
    },
  } as unknown as ObjectStorage;
  const storage = options.storage ?? in_memory;

  const target: StorageTarget = {
    target_id: options.target_id ?? 'target',
    endpoint: 'http://s3.local',
    create_context: async (tenant_id: string): Promise<TenantContext> => {
      if (options.create_error) throw options.create_error;
      created++;
      return {
        tenant_id,
        storage,
        destroy: () => {
          destroyed++;
        },
      } as unknown as TenantContext;
    },
  } as unknown as StorageTarget;

  return {
    target,
    storage,
    created: () => created,
    destroyed: () => destroyed,
  };
}
