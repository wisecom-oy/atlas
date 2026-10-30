import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError, UnreadableContentError } from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import type { IdentityRegistry } from '@wisecom/atlas-types';
import {
  REGISTRY_UPDATE_ATTEMPTS,
  S3IdentityRegistryRepository,
} from '@/adapters/s3-identity-registry-repository.adapter';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';

function make_ctx(body: string | undefined, get_error?: Error): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn(async () => body !== undefined),
      get: vi.fn(async () => {
        if (get_error) throw get_error;
        return Buffer.from(body ?? '', 'utf-8');
      }),
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
  } as unknown as TenantContext;
}

describe('S3IdentityRegistryRepository.load', () => {
  const repo = new S3IdentityRegistryRepository();

  it('returns undefined when no registry exists', async () => {
    await expect(repo.load(make_ctx(undefined))).resolves.toBeUndefined();
  });

  it('returns the stored registry', async () => {
    const registry = { tenant_id: 'tenant-1', entries: [] };
    await expect(repo.load(make_ctx(JSON.stringify(registry)))).resolves.toEqual(registry);
  });

  it('raises StorageError when the registry exists and cannot be fetched', async () => {
    const ctx = make_ctx('{}', new Error('503 Slow Down'));
    await expect(repo.load(ctx)).rejects.toBeInstanceOf(StorageError);
  });

  it('raises UnreadableContentError when the registry fails to decrypt or parse', async () => {
    // Read as absent, the next registration would overwrite every entry (issue #438).
    await expect(repo.load(make_ctx('not-json'))).rejects.toBeInstanceOf(UnreadableContentError);
  });
});

/** A bucket holding at most the registry object, with ETags that change on every write. */
function make_cas_ctx(initial?: IdentityRegistry) {
  let body = initial === undefined ? undefined : JSON.stringify(initial);
  let version = 0;
  const etag = () => `"v${version}"`;
  const put = vi.fn(
    async (
      _key: string,
      data: Buffer,
      _meta?: unknown,
      _lock?: unknown,
      if_match?: string,
      if_none_match?: boolean,
    ) => {
      if (if_none_match && body !== undefined) throw new PreconditionFailedError('registry');
      if (if_match !== undefined && if_match !== etag())
        throw new PreconditionFailedError('registry');
      body = data.toString('utf-8');
      version++;
    },
  );
  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn(async () => body !== undefined),
      get_with_etag: vi.fn(async () => ({ data: Buffer.from(body ?? ''), etag: etag() })),
      put,
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
  } as unknown as TenantContext;
  const overwrite = (registry: IdentityRegistry) => {
    body = JSON.stringify(registry);
    version++;
  };
  const stored = () => (body === undefined ? undefined : (JSON.parse(body) as IdentityRegistry));
  return { ctx, put, overwrite, stored };
}

const entry = (object_id: string) => ({
  object_id,
  email: `${object_id}@example.com`,
  display_name: 'John Doe',
  registered_at: '2026-01-01T00:00:00.000Z',
  status: 'active' as const,
});

const append = (object_id: string) => (current: IdentityRegistry | undefined) => ({
  tenant_id: 'tenant-1',
  entries: [...(current?.entries ?? []), entry(object_id)],
});

describe('S3IdentityRegistryRepository.update', () => {
  const repo = new S3IdentityRegistryRepository();

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the registry with a create-only write when none exists', async () => {
    const { ctx, put, stored } = make_cas_ctx();

    await repo.update(ctx, append('a'));

    expect(put.mock.calls[0]?.[5]).toBe(true);
    expect(put.mock.calls[0]?.[4]).toBeUndefined();
    expect(stored()?.entries.map((e) => e.object_id)).toEqual(['a']);
  });

  it('writes against the ETag it read', async () => {
    const { ctx, put } = make_cas_ctx({ tenant_id: 'tenant-1', entries: [entry('a')] });

    await repo.update(ctx, append('b'));

    expect(put.mock.calls[0]?.[4]).toBe('"v0"');
    expect(put.mock.calls[0]?.[5]).toBe(false);
  });

  it('re-reads and re-applies the mutation when another writer won the race', async () => {
    const harness = make_cas_ctx({ tenant_id: 'tenant-1', entries: [] });
    let raced = false;
    const mutate = (current: IdentityRegistry | undefined) => {
      if (!raced) {
        raced = true;
        harness.overwrite({ tenant_id: 'tenant-1', entries: [entry('other')] });
      }
      return append('mine')(current);
    };

    const pending = repo.update(harness.ctx, mutate);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(harness.put).toHaveBeenCalledTimes(2);
    expect(result?.entries.map((e) => e.object_id)).toEqual(['other', 'mine']);
    expect(harness.stored()?.entries.map((e) => e.object_id)).toEqual(['other', 'mine']);
  });

  it('writes nothing when the mutation reports no change', async () => {
    const initial = { tenant_id: 'tenant-1', entries: [entry('a')] };
    const { ctx, put } = make_cas_ctx(initial);

    await expect(repo.update(ctx, () => undefined)).resolves.toEqual(initial);
    expect(put).not.toHaveBeenCalled();
  });

  it('gives up with a StorageError after the attempt budget is spent', async () => {
    const { ctx, put } = make_cas_ctx({ tenant_id: 'tenant-1', entries: [] });
    put.mockRejectedValue(new PreconditionFailedError('registry'));

    const pending = repo.update(ctx, append('a'));
    const assertion = expect(pending).rejects.toBeInstanceOf(StorageError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(put).toHaveBeenCalledTimes(REGISTRY_UPDATE_ATTEMPTS);
  });

  it('propagates a write failure that is not a precondition failure', async () => {
    const { ctx, put } = make_cas_ctx();
    put.mockRejectedValue(new Error('AccessDenied'));

    await expect(repo.update(ctx, append('a'))).rejects.toThrow('AccessDenied');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('never overwrites a registry it cannot decrypt', async () => {
    const { ctx, put } = make_cas_ctx();
    vi.mocked(ctx.storage.exists).mockResolvedValue(true);
    vi.mocked(ctx.storage.get_with_etag).mockResolvedValue({
      data: Buffer.from('nope'),
      etag: '"x"',
    });

    await expect(repo.update(ctx, append('a'))).rejects.toBeInstanceOf(UnreadableContentError);
    expect(put).not.toHaveBeenCalled();
  });
});
