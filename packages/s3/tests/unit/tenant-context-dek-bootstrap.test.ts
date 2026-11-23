import { BucketCache } from '@/adapters/bucket-cache';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';
import { ConfiguredBucketNameResolver } from '@/adapters/configured-bucket-name-resolver';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { ConfigError, WrongPassphraseError } from '@wisecom/atlas-types';

const DERIVED = new ConfiguredBucketNameResolver(undefined);

// Regression tests for issue #25: two processes bootstrapping the same fresh
// tenant concurrently must converge on one DEK - the loser of the create-only
// write adopts the winner's key instead of overwriting it.

interface CommandLike {
  input: { Key?: string; Bucket?: string; Body?: Buffer; IfNoneMatch?: string };
}

/**
 * Stateful in-memory S3 fake: HeadBucket always succeeds, objects live in a
 * shared map, and PutObject honours IfNoneMatch: '*' with a 412 like AWS S3.
 * The first `force_missing_heads` HeadObject calls report 404 regardless of
 * state, so two racing factories both observe "no DEK yet".
 */
function make_racing_s3(force_missing_heads: number) {
  const objects = new Map<string, Buffer>();
  let head_count = 0;

  const not_found = () =>
    Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

  const send = vi.fn(async (cmd: CommandLike) => {
    const name = cmd.constructor.name;
    const key = cmd.input.Key ?? '';

    if (name === 'HeadBucketCommand') return {};
    if (name === 'HeadObjectCommand') {
      if (++head_count <= force_missing_heads || !objects.has(key)) throw not_found();
      return {};
    }
    if (name === 'PutObjectCommand') {
      if (cmd.input.IfNoneMatch === '*' && objects.has(key)) {
        throw Object.assign(new Error('PreconditionFailed'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      }
      objects.set(key, Buffer.from(cmd.input.Body ?? Buffer.alloc(0)));
      return {};
    }
    if (name === 'GetObjectCommand') {
      const data = objects.get(key);
      if (!data) throw not_found();
      return { Body: { transformToByteArray: async () => new Uint8Array(data) } };
    }
    throw new Error(`Unexpected command in fake S3: ${name}`);
  });

  return { send, objects };
}

const CONFIG = { encryption_passphrase: 'unit-test-passphrase-long' } as AtlasConfig;

function make_factory(
  s3: { send: ReturnType<typeof vi.fn> },
  buckets: BucketCache,
): DefaultTenantContextFactory {
  return new DefaultTenantContextFactory(s3 as never, CONFIG, buckets, DERIVED);
}

describe('DEK bootstrap race (issue #25)', () => {
  let buckets: BucketCache;
  beforeEach(() => {
    buckets = new BucketCache();
    vi.restoreAllMocks();
  });

  it('two concurrent bootstraps of a fresh tenant converge on one DEK', async () => {
    const s3 = make_racing_s3(2);
    const [ctx_a, ctx_b] = await Promise.all([
      make_factory(s3, buckets).create('tenant-race'),
      make_factory(s3, buckets).create('tenant-race'),
    ]);

    // exactly one wrapped DEK object exists
    expect(s3.objects.size).toBe(1);

    // data encrypted by either context decrypts with the other
    const secret = Buffer.from('cross-process payload');
    expect(
      ctx_b.decrypt(
        ctx_a.encrypt(secret, 'onedrive/data/owner-1/blob'),
        'onedrive/data/owner-1/blob',
      ),
    ).toEqual(secret);
    expect(
      ctx_a.decrypt(
        ctx_b.encrypt(secret, 'onedrive/data/owner-1/blob'),
        'onedrive/data/owner-1/blob',
      ),
    ).toEqual(secret);
  });

  it('a later bootstrap loads the existing DEK instead of writing', async () => {
    const s3 = make_racing_s3(0);
    const ctx_first = await make_factory(s3, buckets).create('tenant-1');
    const put_calls_after_first = s3.send.mock.calls.filter(
      ([cmd]) => (cmd as CommandLike).constructor.name === 'PutObjectCommand',
    ).length;

    const ctx_second = await make_factory(s3, buckets).create('tenant-1');

    const put_calls_total = s3.send.mock.calls.filter(
      ([cmd]) => (cmd as CommandLike).constructor.name === 'PutObjectCommand',
    ).length;
    expect(put_calls_total).toBe(put_calls_after_first);

    const secret = Buffer.from('same key across runs');
    expect(
      ctx_second.decrypt(
        ctx_first.encrypt(secret, 'onedrive/data/owner-1/blob'),
        'onedrive/data/owner-1/blob',
      ),
    ).toEqual(secret);
  });

  it('every DEK write is create-only', async () => {
    const s3 = make_racing_s3(0);
    await make_factory(s3, buckets).create('tenant-2');

    const dek_puts = s3.send.mock.calls.filter(([cmd]) => {
      const c = cmd as CommandLike;
      return c.constructor.name === 'PutObjectCommand' && c.input.Key === '_meta/dek.enc';
    });
    expect(dek_puts.length).toBe(1);
    expect((dek_puts[0]![0] as CommandLike).input.IfNoneMatch).toBe('*');
  });

  it('refuses to create a tenant key under a passphrase shorter than 14 bytes (issue #447)', async () => {
    const s3 = make_racing_s3(0);
    const short = { encryption_passphrase: 'abcd' } as AtlasConfig;

    await expect(
      new DefaultTenantContextFactory(s3 as never, short, buckets, DERIVED).create('tenant-new'),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(s3.objects.size).toBe(0);
  });

  // Issue #803: losing the race is routine. It must read as one info line, not
  // as two warnings that suggest key corruption.
  describe('reporting the adopted key (issue #803)', () => {
    const LOST_RACE = /another run created the data key first; using it/;

    /** Creates the winner's key, then has a second factory lose the create-only write. */
    async function lose_bootstrap_race(loser_config: AtlasConfig): Promise<unknown> {
      const s3 = make_racing_s3(2);
      await make_factory(s3, buckets).create('tenant-race');
      vi.clearAllMocks();
      const loser = new DefaultTenantContextFactory(s3 as never, loser_config, buckets, DERIVED);
      return loser.create('tenant-race').catch((err: unknown) => err);
    }

    it('logs one info line and no warning for the run that lost the race', async () => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const outcome = await lose_bootstrap_race(CONFIG);

      expect(outcome).not.toBeInstanceOf(Error);
      expect(warn).not.toHaveBeenCalled();
      const race_lines = info.mock.calls.filter(([message]) => LOST_RACE.test(message));
      expect(race_lines).toEqual([
        ['Tenant tenant-race: another run created the data key first; using it'],
      ]);
    });

    it('still fails loudly when the winning key does not open under this passphrase', async () => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const other = { encryption_passphrase: 'a-different-passphrase' } as AtlasConfig;

      const outcome = await lose_bootstrap_race(other);

      expect(outcome).toBeInstanceOf(WrongPassphraseError);
      expect(info.mock.calls.some(([message]) => LOST_RACE.test(message))).toBe(false);
    });

    it('warns when a create-only write was accepted but storage holds another key', async () => {
      const s3 = make_racing_s3(2);
      await make_factory(s3, buckets).create('tenant-race');
      // A backend that ignores If-None-Match accepts the write, and a second
      // writer's key lands after it, so the read-back returns a foreign key.
      const honour_conditions = s3.send.getMockImplementation()!;
      s3.send.mockImplementation(async (cmd: CommandLike) =>
        cmd.constructor.name === 'PutObjectCommand' ? {} : honour_conditions(cmd),
      );
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await make_factory(s3, buckets).create('tenant-race');

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/not the one this run wrote/);
      expect(info.mock.calls.some(([message]) => LOST_RACE.test(message))).toBe(false);
    });
  });
});
