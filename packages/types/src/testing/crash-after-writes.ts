import type { ObjectStorage } from '@/ports/storage/object-storage.port';

const WRITE_METHODS = ['put', 'delete', 'delete_version', 'delete_batch', 'copy'] as const;

/** A bucket that fails every write from a chosen one on, as a process that dies would. */
export interface CrashingStorage {
  readonly storage: ObjectStorage;
  /** Writes that went through so far. */
  readonly writes: () => number;
}

/**
 * Wraps `storage` so that write number `crash_at` (counting from 0) and every write after it
 * throws, and nothing it would have changed changes. `Infinity` never crashes, which counts the
 * writes a whole run makes. Reads always pass through.
 */
export function crash_after_writes(storage: ObjectStorage, crash_at: number): CrashingStorage {
  let writes = 0;
  const wrapped: Record<string, unknown> = { ...storage };
  for (const method of WRITE_METHODS) {
    const original = storage[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (original === undefined) continue;
    wrapped[method] = async (...args: unknown[]): Promise<unknown> => {
      if (writes >= crash_at) throw new Error(`simulated crash before write ${writes}`);
      writes++;
      return original.apply(storage, args);
    };
  }
  return { storage: wrapped as unknown as ObjectStorage, writes: () => writes };
}
