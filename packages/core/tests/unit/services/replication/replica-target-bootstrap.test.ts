import { describe, it, expect } from 'vitest';
import type { ObjectStorage, TenantContext } from '@wisecom/atlas-types';
import {
  ensure_dek_on_target,
  ensure_replica_marker,
} from '@/services/replication/replica-target-bootstrap';
import { DekWriteConflictError } from '@/services/replication/conditional-dek-write';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';

// Issue #639: the replicators wrote the target DEK and replica marker with plain puts after an
// existence check, so a concurrent writer in between was overwritten.

const DEK_KEY = '_meta/dek.enc';
const MARKER_KEY = '_meta/replica.marker';
const SOURCE_DEK = Buffer.from('wrapped-source-dek');

/** Target context whose `exists` lets a concurrent writer act right after the check. */
function target_with_race(bucket: InMemoryTenantContext, concurrent_write: () => void) {
  const inner = bucket.ctx.storage;
  const storage = {
    ...inner,
    exists: async (key: string) => {
      const found = await inner.exists(key);
      concurrent_write();
      return found;
    },
  } as ObjectStorage;
  return { ...bucket.ctx, storage } as TenantContext;
}

function source_ctx(): TenantContext {
  const source = in_memory_tenant_context('tenant-1');
  source.set_raw(DEK_KEY, SOURCE_DEK);
  return source.ctx;
}

describe('ensure_dek_on_target (issue #639)', () => {
  it('copies the source key into an empty target', async () => {
    const target = in_memory_tenant_context('tenant-1');

    await ensure_dek_on_target(source_ctx(), target.ctx);

    expect(target.raw(DEK_KEY)).toEqual(SOURCE_DEK);
  });

  it('refuses instead of overwriting a different key stored after the check', async () => {
    const target = in_memory_tenant_context('tenant-1');
    const rival = Buffer.from('wrapped-rival-dek');
    const ctx = target_with_race(target, () => target.set_raw(DEK_KEY, rival));

    await expect(ensure_dek_on_target(source_ctx(), ctx)).rejects.toBeInstanceOf(
      DekWriteConflictError,
    );
    expect(target.raw(DEK_KEY)).toEqual(rival);
  });

  it('accepts a concurrent run that stored the same key', async () => {
    const target = in_memory_tenant_context('tenant-1');
    const ctx = target_with_race(target, () => target.set_raw(DEK_KEY, SOURCE_DEK));

    await ensure_dek_on_target(source_ctx(), ctx);

    expect(target.raw(DEK_KEY)).toEqual(SOURCE_DEK);
  });
});

describe('ensure_replica_marker (issue #639)', () => {
  it('writes the marker when the target has none', async () => {
    const target = in_memory_tenant_context('tenant-1');

    await ensure_replica_marker(target.ctx, 'tenant-1');

    const marker = JSON.parse(target.raw(MARKER_KEY)?.toString('utf-8') ?? '{}');
    expect(marker.replicated_from_tenant).toBe('tenant-1');
  });

  it('keeps a marker a concurrent run created after the check', async () => {
    const target = in_memory_tenant_context('tenant-1');
    const first = Buffer.from('{"replicated_from_tenant":"tenant-1","created_at":"earlier"}');
    const ctx = target_with_race(target, () => target.set_raw(MARKER_KEY, first));

    await ensure_replica_marker(ctx, 'tenant-1');

    expect(target.raw(MARKER_KEY)).toEqual(first);
  });
});
