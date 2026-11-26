/**
 * Issues #623 and #915: the owner lease only excludes a second run when the backend refuses a
 * create-only write onto an existing key and a compare-and-swap with a stale ETag, and accepts a
 * compare-and-swap with the current ETag. The probe checks all three with a throwaway object.
 */
import { describe, expect, it } from 'vitest';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  probe_conditional_writes,
  run_conditional_write_probe,
} from '@/adapters/s3-conditional-write-probe';

/** An in-memory bucket that honours write conditions, with the version calls the cleanup makes. */
function conditional_bucket(
  overrides: (inner: ObjectStorage) => Partial<ObjectStorage> = () => ({}),
) {
  const harness = in_memory_tenant_context();
  const inner = harness.ctx.storage;
  const versioned = {
    ...inner,
    list_versions: async () => [],
    delete_version: async () => undefined,
  };
  const storage = { ...versioned, ...overrides(inner) } as ObjectStorage;
  return { harness, storage };
}

describe('probe_conditional_writes (issues #623, #915)', () => {
  it('reports support when both conditional writes are refused, and leaves nothing behind', async () => {
    const { harness, storage } = conditional_bucket();

    await expect(probe_conditional_writes(storage)).resolves.toEqual({ support: 'supported' });

    expect(harness.keys()).toEqual([]);
  });

  it('writes its probe object under _meta/storage-check/ as plain text', async () => {
    const written: { key: string; body: string }[] = [];
    const { storage } = conditional_bucket((inner) => ({
      put: async (key, data, ...rest) => {
        written.push({ key, body: data.toString('utf-8') });
        return inner.put(key, data, ...rest);
      },
    }));

    await probe_conditional_writes(storage);

    expect(new Set(written.map((write) => write.key)).size).toBe(1);
    expect(written[0]?.key).toMatch(/^_meta\/storage-check\/[0-9a-f-]{36}\.probe$/);
    expect(written.every((write) => write.body.startsWith('atlas storage-check probe'))).toBe(true);
  });

  it('reports a backend that ignores If-None-Match', async () => {
    const { harness, storage } = conditional_bucket((inner) => ({
      put: async (key, data, metadata, policy, if_match) =>
        inner.put(key, data, metadata, policy, if_match),
    }));

    const result = await probe_conditional_writes(storage);

    expect(result).toEqual({
      support: 'ignored',
      detail: 'the backend accepted a create-only write (If-None-Match: *) onto an existing object',
      violations: ['create_only'],
    });
    expect(harness.keys()).toEqual([]);
  });

  it('reports a backend that ignores a stale If-Match', async () => {
    const { storage } = conditional_bucket((inner) => ({
      put: async (key, data, metadata, policy, _if_match, if_none_match) =>
        inner.put(key, data, metadata, policy, undefined, if_none_match),
    }));

    const result = await probe_conditional_writes(storage);

    expect(result).toEqual({
      support: 'ignored',
      detail: 'the backend accepted a compare-and-swap (If-Match) with a stale ETag',
      violations: ['stale_if_match'],
    });
  });

  it('reports a backend that ignores both conditions, as Garage and CloudServer do', async () => {
    const { storage } = conditional_bucket((inner) => ({
      put: async (key, data) => inner.put(key, data),
    }));

    const result = await probe_conditional_writes(storage);

    expect(result.support).toBe('ignored');
    expect(result.violations).toEqual(['create_only', 'stale_if_match']);
    expect(result.detail).toBe(
      'the backend accepted a create-only write (If-None-Match: *) onto an existing object; ' +
        'accepted a compare-and-swap (If-Match) with a stale ETag',
    );
  });

  it('reports a backend that refuses If-Match with the current ETag, as Ceph RGW 18 does', async () => {
    const refused = Object.assign(new Error('Precondition Failed'), { name: 'PreconditionFailed' });
    const { harness, storage } = conditional_bucket((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        if (if_match !== undefined) throw refused;
        return inner.put(key, data, metadata, policy, undefined, if_none_match);
      },
    }));

    const result = await probe_conditional_writes(storage);

    expect(result).toEqual({
      support: 'ignored',
      detail: 'the backend refused a compare-and-swap (If-Match) with the current ETag',
      violations: ['current_if_match'],
    });
    expect(harness.keys()).toEqual([]);
  });

  it('sends the current ETag last, after reading it back', async () => {
    const etags: (string | undefined)[] = [];
    const { storage } = conditional_bucket((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        etags.push(if_match);
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));

    await probe_conditional_writes(storage);

    const [stale, current] = etags.filter((etag) => etag !== undefined);
    expect(etags).toHaveLength(5);
    expect(current).toBeDefined();
    expect(current).not.toBe(stale);
  });

  it('does not probe a bucket that does not exist yet', async () => {
    const { storage } = conditional_bucket(() => ({
      put: async () => {
        throw Object.assign(new Error('The specified bucket does not exist'), {
          name: 'NoSuchBucket',
        });
      },
    }));

    await expect(probe_conditional_writes(storage)).resolves.toEqual({
      support: 'not_probed',
      detail: 'the bucket does not exist yet',
    });
  });

  it('does not fail the check when the credentials may not write', async () => {
    const { storage } = conditional_bucket(() => ({
      put: async () => {
        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      },
    }));

    const result = await probe_conditional_writes(storage);

    expect(result.support).toBe('not_probed');
    expect(result.detail).toContain('Access Denied');
  });

  it('removes every version of the probe object in a versioned bucket', async () => {
    const removed: string[] = [];
    const { storage } = conditional_bucket(() => ({
      list_versions: async (key) => [
        { key, version_id: 'v2', is_delete_marker: true },
        { key, version_id: 'v1', is_delete_marker: false },
        { key: `${key}.other`, version_id: 'v9', is_delete_marker: false },
      ],
      delete_version: async (_key, version_id) => {
        removed.push(version_id);
      },
    }));

    await probe_conditional_writes(storage);

    expect(removed).toEqual(['v2', 'v1']);
  });

  it('still answers when the probe object cannot be removed', async () => {
    const { storage } = conditional_bucket(() => ({
      delete: async () => {
        throw new Error('retained');
      },
    }));

    await expect(probe_conditional_writes(storage)).resolves.toEqual({ support: 'supported' });
  });

  describe('whether the answer may change within the process', () => {
    it('is final for a verdict', async () => {
      const { storage } = conditional_bucket((inner) => ({
        put: async (key, data) => inner.put(key, data),
      }));

      await expect(run_conditional_write_probe(storage)).resolves.toMatchObject({
        provisional: false,
      });
    });

    it('is final when the credentials may not write', async () => {
      const { storage } = conditional_bucket(() => ({
        put: async () => {
          throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
        },
      }));

      await expect(run_conditional_write_probe(storage)).resolves.toMatchObject({
        check: { support: 'not_probed' },
        provisional: false,
      });
    });

    it('is provisional while the bucket does not exist', async () => {
      const { storage } = conditional_bucket(() => ({
        put: async () => {
          throw Object.assign(new Error('missing'), { name: 'NoSuchBucket' });
        },
      }));

      await expect(run_conditional_write_probe(storage)).resolves.toMatchObject({
        provisional: true,
      });
    });

    it('is provisional when a request fails partway, and is not reported as ignored', async () => {
      const { harness, storage } = conditional_bucket((inner) => ({
        get_with_etag: async () => {
          throw Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable' });
        },
        put: inner.put,
      }));

      await expect(run_conditional_write_probe(storage)).resolves.toEqual({
        check: { support: 'not_probed', detail: 'the probe failed: Service Unavailable' },
        provisional: true,
      });
      expect(harness.keys()).toEqual([]);
    });
  });
});
