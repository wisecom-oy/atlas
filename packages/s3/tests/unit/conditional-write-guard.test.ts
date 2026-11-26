/**
 * Issue #915: every conditional write first confirms that the bucket enforces conditional writes,
 * probing once per bucket per process, and refuses a backend that does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { BucketCache } from '@/adapters/bucket-cache';
import { require_conditional_writes } from '@/adapters/conditional-write-guard';
import { ConditionalWritesNotEnforcedError } from '@/adapters/conditional-write.errors';
import type { ConditionalWriteProbeOutcome } from '@/adapters/s3-conditional-write-probe';

const SUPPORTED: ConditionalWriteProbeOutcome = {
  check: { support: 'supported' },
  provisional: false,
};

const IGNORED: ConditionalWriteProbeOutcome = {
  check: {
    support: 'ignored',
    detail: 'the backend accepted a create-only write (If-None-Match: *) onto an existing object',
    violations: ['create_only'],
  },
  provisional: false,
};

function unprobed(detail: string, provisional: boolean): ConditionalWriteProbeOutcome {
  return { check: { support: 'not_probed', detail }, provisional };
}

describe('require_conditional_writes (issue #915)', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());

  it('lets a write through on a backend that enforces conditional writes', async () => {
    const probe = vi.fn(async () => SUPPORTED);

    await expect(
      require_conditional_writes('b', new BucketCache(), probe),
    ).resolves.toBeUndefined();

    expect(probe).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a backend that broke a rule, with a ConfigError that names it', async () => {
    const refusal = await require_conditional_writes('b', new BucketCache(), async () => IGNORED)
      .then(() => undefined)
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ConditionalWritesNotEnforcedError);
    expect(refusal).toBeInstanceOf(ConfigError);
    const error = refusal as ConditionalWritesNotEnforcedError;
    expect(error.code).toBe('ATLAS_CONFIG_INVALID');
    expect(error.bucket).toBe('b');
    expect(error.violations).toEqual(['create_only']);
    expect(error.message).toContain('If-None-Match: *');
    expect(error.message).toContain('self-hosting/storage#conditional-writes');
  });

  it('probes each bucket once, however many writes follow', async () => {
    const cache = new BucketCache();
    const probe = vi.fn(async () => SUPPORTED);

    await Promise.all([1, 2, 3].map(() => require_conditional_writes('b', cache, probe)));
    await require_conditional_writes('b', cache, probe);
    await require_conditional_writes('other', cache, probe);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('keeps refusing from the remembered verdict without probing again', async () => {
    const cache = new BucketCache();
    const probe = vi.fn(async () => IGNORED);

    await expect(require_conditional_writes('b', cache, probe)).rejects.toThrow();
    await expect(require_conditional_writes('b', cache, probe)).rejects.toThrow();

    expect(probe).toHaveBeenCalledOnce();
  });

  it('lets the write through when the probe could not run, and probes again next time', async () => {
    const cache = new BucketCache();
    const probe = vi
      .fn<() => Promise<ConditionalWriteProbeOutcome>>()
      .mockResolvedValueOnce(unprobed('the probe failed: Service Unavailable', true))
      .mockResolvedValueOnce(IGNORED);

    await expect(require_conditional_writes('b', cache, probe)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Service Unavailable'));

    await expect(require_conditional_writes('b', cache, probe)).rejects.toBeInstanceOf(
      ConditionalWritesNotEnforcedError,
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('remembers credentials that may not write, and warns once', async () => {
    const cache = new BucketCache();
    const probe = vi.fn(async () =>
      unprobed('the probe object could not be written: Access Denied', false),
    );

    await require_conditional_writes('b', cache, probe);
    await require_conditional_writes('b', cache, probe);

    expect(probe).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('forgets a probe that threw, so the next write probes again', async () => {
    const cache = new BucketCache();
    const probe = vi
      .fn<() => Promise<ConditionalWriteProbeOutcome>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(SUPPORTED);

    await expect(require_conditional_writes('b', cache, probe)).rejects.toThrow('boom');
    await expect(require_conditional_writes('b', cache, probe)).resolves.toBeUndefined();
  });

  it('forgets every verdict on clear()', async () => {
    const cache = new BucketCache();
    const probe = vi.fn(async () => SUPPORTED);

    await require_conditional_writes('b', cache, probe);
    cache.clear();
    await require_conditional_writes('b', cache, probe);

    expect(probe).toHaveBeenCalledTimes(2);
  });
});
