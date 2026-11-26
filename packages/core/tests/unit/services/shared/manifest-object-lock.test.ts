import { describe, expect, it, vi } from 'vitest';
import type { ObjectStorage, TenantContext } from '@wisecom/atlas-types';
import { apply_run_retention, ObjectLockingStorage } from '@/services/shared/run-object-lock';
import {
  build_manifest_object_lock_policy,
  parse_stored_object_lock,
  summarize_manifest_object_lock,
  with_run_object_lock,
} from '@/services/shared/manifest-object-lock';

// Issue #975: the policy a run stamps on its objects is recorded once, by the same code, for every
// workload that reports it.

const RETAIN_UNTIL = '2099-01-01T00:00:00.000Z';

function make_ctx(): TenantContext {
  const storage = { put: vi.fn(), validate_object_lock_policy: vi.fn() };
  return { tenant_id: 't', storage, destroy: vi.fn() } as unknown as TenantContext;
}

describe('apply_run_retention', () => {
  it('returns the policy it stamps, beside the locking context', async () => {
    const ctx = make_ctx();

    const retention = await apply_run_retention(ctx, { mode: 'COMPLIANCE', retention_days: 30 });

    expect(retention.ctx.storage).toBeInstanceOf(ObjectLockingStorage);
    await retention.ctx.storage.put('k', Buffer.from('x'));
    const stamped = vi.mocked(ctx.storage as ObjectStorage).put.mock.calls[0]?.[3];
    expect(retention.object_lock).toEqual({
      requested: { mode: 'COMPLIANCE', retention_days: 30 },
      effective: stamped,
    });
  });

  it('returns no policy and the context unchanged without retention days', async () => {
    const ctx = make_ctx();

    const retention = await apply_run_retention(ctx, { mode: 'COMPLIANCE' });

    expect(retention.ctx).toBe(ctx);
    expect(retention).not.toHaveProperty('object_lock');
  });
});

describe('build_manifest_object_lock_policy', () => {
  it('records the request next to the applied policy', () => {
    expect(
      build_manifest_object_lock_policy(
        { retention_days: 7 },
        { mode: 'GOVERNANCE', retain_until: RETAIN_UNTIL },
      ),
    ).toEqual({
      requested: { mode: undefined, retention_days: 7 },
      effective: { mode: 'GOVERNANCE', retain_until: RETAIN_UNTIL },
    });
  });

  it('records nothing when no policy was applied', () => {
    expect(build_manifest_object_lock_policy({ retention_days: 7 }, undefined)).toBeUndefined();
  });
});

describe('summarize_manifest_object_lock', () => {
  it('keeps the applied policy when it has a retain-until instant', () => {
    const effective = { mode: 'COMPLIANCE' as const, retain_until: RETAIN_UNTIL };

    expect(summarize_manifest_object_lock({ requested: {}, effective })).toEqual(effective);
  });

  it('drops a policy that locks nothing and an absent one', () => {
    expect(summarize_manifest_object_lock({ requested: {}, effective: {} })).toBeUndefined();
    expect(summarize_manifest_object_lock(undefined)).toBeUndefined();
  });
});

describe('parse_stored_object_lock', () => {
  it('reads a stored policy, and absence as undefined', () => {
    const stored = { mode: 'GOVERNANCE', retain_until: RETAIN_UNTIL };

    expect(parse_stored_object_lock(stored)).toEqual(stored);
    expect(parse_stored_object_lock(undefined)).toBeUndefined();
  });

  it('rejects a malformed policy with null', () => {
    expect(parse_stored_object_lock('GOVERNANCE')).toBeNull();
    expect(parse_stored_object_lock({ mode: 'NONE' })).toBeNull();
    expect(parse_stored_object_lock({ retain_until: 4102444800 })).toBeNull();
  });
});

describe('with_run_object_lock', () => {
  it('adds the policy to a result, and leaves a result without one unchanged', () => {
    const result = { snapshot: undefined };
    const object_lock = { requested: {}, effective: { retain_until: RETAIN_UNTIL } };

    expect(with_run_object_lock(result, object_lock)).toEqual({ snapshot: undefined, object_lock });
    expect(with_run_object_lock(result, undefined)).toBe(result);
  });
});
