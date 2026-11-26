import type { WriterExclusionMode } from '@wisecom/atlas-types';
import { KeyedWriteSerializer } from '@/adapters/keyed-write-serializer';

/**
 * How conditional writes reach this container's buckets (issue #974). In the default
 * `storage_lease` mode they carry `If-None-Match` and `If-Match`, and a backend that does not
 * enforce them is refused. In an opt-in mode no condition is sent: Atlas checks it, writes
 * unconditionally, and confirms the write, serialising checked writes to one key in this process.
 */
export class ConditionalWritePolicy {
  /** Shared by every storage of the container, so two writes to one key never interleave. */
  readonly key_serializer = new KeyedWriteSerializer();

  constructor(readonly mode: WriterExclusionMode) {}

  /** True when Atlas checks write conditions itself instead of sending them to the backend. */
  emulates_conditions(): boolean {
    return this.mode !== 'storage_lease';
  }
}

/** The default policy, for a storage built without one. */
export const STORAGE_LEASE_POLICY = new ConditionalWritePolicy('storage_lease');
