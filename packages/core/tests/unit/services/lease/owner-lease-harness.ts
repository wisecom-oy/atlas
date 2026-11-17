import type { ObjectStorage, OwnerLeaseRequest, TenantContext } from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import type { OwnerLeaseRecord } from '@/services/lease/owner-lease-record';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';

export const START_MS = Date.parse('2026-03-01T10:00:00.000Z');
export const MINUTE_MS = 60_000;

export const OUTLOOK_BACKUP: OwnerLeaseRequest = {
  workload: 'outlook',
  owner_id: 'owner-1',
  operation: 'backup',
};
export const OUTLOOK_KEY = owner_lease_key('outlook', 'owner-1');

/** An in-memory bucket with a clock and a renewal timer the test drives by hand. */
export interface LeaseHarness {
  readonly bucket: InMemoryTenantContext;
  readonly ctx: TenantContext;
  /** Leases over the shared clock; holder ids are `holder-1`, `holder-2`, in acquire order. */
  readonly leases: StorageOwnerLeases;
  readonly now: () => number;
  readonly advance: (ms: number) => void;
  /** Fires every active renewal timer once and waits for the renewals to settle. */
  readonly tick: () => Promise<void>;
  /** Renewal timers that were started and not stopped. */
  readonly active_timers: () => number;
  /** The lease body in storage, or undefined when there is none. It is plain JSON. */
  readonly stored: (key?: string) => OwnerLeaseRecord | undefined;
  /** Stores a lease body as another run would have. */
  readonly store: (record: Partial<OwnerLeaseRecord>, key?: string) => void;
}

/** Waits for every promise chain the in-memory storage started to finish. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Builds the harness. `wrap_storage` replaces storage methods to inject a fault or a competitor. */
export function lease_harness(
  wrap_storage: (inner: ObjectStorage) => Partial<ObjectStorage> = () => ({}),
): LeaseHarness {
  const bucket = in_memory_tenant_context();
  const inner = bucket.ctx.storage;
  const ctx = { ...bucket.ctx, storage: { ...inner, ...wrap_storage(inner) } } as TenantContext;
  let now_ms = START_MS;
  let holders = 0;
  const timers = new Set<() => void>();
  const leases = new StorageOwnerLeases({
    now: () => now_ms,
    schedule: (run_tick) => {
      timers.add(run_tick);
      return () => timers.delete(run_tick);
    },
    new_holder_id: () => `holder-${++holders}`,
  });
  return {
    bucket,
    ctx,
    leases,
    now: () => now_ms,
    advance: (ms) => {
      now_ms += ms;
    },
    tick: async () => {
      for (const run_tick of [...timers]) run_tick();
      await settle();
    },
    active_timers: () => timers.size,
    stored: (key = OUTLOOK_KEY) => {
      const raw = bucket.raw(key);
      if (raw === undefined) return undefined;
      return JSON.parse(raw.toString('utf-8')) as OwnerLeaseRecord;
    },
    store: (record, key = OUTLOOK_KEY) => {
      const body = {
        format_version: 1,
        holder_id: 'another-run',
        operation: 'backup',
        acquired_at: new Date(now_ms).toISOString(),
        expires_at: new Date(now_ms + 5 * MINUTE_MS).toISOString(),
        ...record,
      };
      bucket.set_raw(key, Buffer.from(JSON.stringify(body)));
    },
  };
}

/** A storage error shaped like a refused conditional write. */
export function precondition_failed(): Error {
  return Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
}
