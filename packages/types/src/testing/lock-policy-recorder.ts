import type { ObjectStorage, StorageObjectLockPolicy } from '@/index';

/**
 * Storage that records, per key, whether each write reached it with a retain-until date. Place it
 * under a run's lock decorator to see which keys the run locked and which it left unlocked.
 */
export interface LockPolicyRecorder {
  /** Forwards every call to the wrapped storage, recording puts, copies and multipart uploads. */
  readonly storage: ObjectStorage;
  /** Keys written at least once with a retain-until date, sorted. */
  readonly locked_keys: () => string[];
  /** Keys written at least once without one, sorted. */
  readonly unlocked_keys: () => string[];
}

/** Wraps `inner` so a test can assert which keys were written under Object Lock retention. */
export function record_lock_policies(inner: ObjectStorage): LockPolicyRecorder {
  const locked = new Set<string>();
  const unlocked = new Set<string>();
  const note = (key: string, policy: StorageObjectLockPolicy | undefined): void => {
    (policy?.retain_until ? locked : unlocked).add(key);
  };
  const recording: Partial<ObjectStorage> = {
    put: (key, data, metadata, policy, if_match, if_none_match) => {
      note(key, policy);
      return inner.put(key, data, metadata, policy, if_match, if_none_match);
    },
    copy: (source_key, dest_key, metadata, policy) => {
      note(dest_key, policy);
      return inner.copy(source_key, dest_key, metadata, policy);
    },
    begin_multipart_upload: (key, metadata, policy) => {
      note(key, policy);
      return inner.begin_multipart_upload(key, metadata, policy);
    },
  };
  const storage = new Proxy(inner, {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && property in recording) {
        return recording[property as keyof ObjectStorage];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return {
    storage,
    locked_keys: () => [...locked].sort(),
    unlocked_keys: () => [...unlocked].sort(),
  };
}
