import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validate_dek_match, DekMismatchError } from '@/adapters/dek-validator';
import { EnvelopeKeyService } from '@wisecom/atlas-core';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { WrongPassphraseError } from '@wisecom/atlas-types';

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    list_stale: vi.fn(async () => []),
    list_versions: vi.fn(),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    get_with_etag: vi.fn(),
    get_stream: vi.fn(),
    apply_default_retention: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn(),
  };
}

describe('validate_dek_match', () => {
  const passphrase = 'test-passphrase';
  const tenant_id = 'tenant-1';
  let source_storage: ObjectStorage;
  let target_storage: ObjectStorage;

  beforeEach(() => {
    source_storage = make_storage();
    target_storage = make_storage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes when target has no dek.enc', async () => {
    vi.mocked(target_storage.exists).mockResolvedValue(false);

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).resolves.toBeUndefined();

    expect(source_storage.get).not.toHaveBeenCalled();
  });

  it('passes when both sides have the same DEK', async () => {
    const key_service = new EnvelopeKeyService(passphrase);
    const dek = key_service.generate_dek();
    const wrapped = key_service.wrap_dek(dek, tenant_id);

    vi.mocked(target_storage.exists).mockImplementation(async (key: string) =>
      key === '_meta/dek.enc' ? true : false,
    );
    for (const s of [source_storage, target_storage]) {
      vi.mocked(s.exists).mockImplementation(async (key: string) =>
        key === '_meta/dek.enc' ? true : false,
      );
      vi.mocked(s.get).mockImplementation(async (key: string) => {
        if (key === '_meta/dek.enc') return wrapped;
        throw new Error(`unexpected get(${key})`);
      });
    }

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).resolves.toBeUndefined();
  });

  it('throws DekMismatchError when DEKs differ', async () => {
    const key_service = new EnvelopeKeyService(passphrase);
    const dek_a = key_service.generate_dek();
    const dek_b = key_service.generate_dek();
    const wrapped_a = key_service.wrap_dek(dek_a, tenant_id);
    const wrapped_b = key_service.wrap_dek(dek_b, tenant_id);

    for (const [s, wrapped] of [
      [source_storage, wrapped_a],
      [target_storage, wrapped_b],
    ] as const) {
      vi.mocked(s.exists).mockImplementation(async (key: string) =>
        key === '_meta/dek.enc' ? true : false,
      );
      vi.mocked(s.get).mockImplementation(async (key: string) => {
        if (key === '_meta/dek.enc') return wrapped;
        throw new Error(`unexpected get(${key})`);
      });
    }

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).rejects.toThrow(DekMismatchError);
  });

  /** Serves the given wrapped DEK blobs as `_meta/dek.enc` on the source and target storage. */
  async function store_wrapped_deks(
    source_dek_blob: Buffer,
    target_dek_blob: Buffer,
  ): Promise<void> {
    for (const [s, wrapped] of [
      [source_storage, source_dek_blob],
      [target_storage, target_dek_blob],
    ] as const) {
      vi.mocked(s.exists).mockImplementation(async (key: string) => key === '_meta/dek.enc');
      vi.mocked(s.get).mockImplementation(async (key: string) => {
        if (key === '_meta/dek.enc') return wrapped;
        throw new Error(`unexpected get(${key})`);
      });
    }
  }

  it('destroys the key service when the second unwrap throws (issue #436)', async () => {
    const writer = new EnvelopeKeyService(passphrase);
    const wrapped_source = await writer.wrap_dek(writer.generate_dek(), tenant_id);
    const other = new EnvelopeKeyService('a-different-passphrase');
    const wrapped_target = await other.wrap_dek(other.generate_dek(), tenant_id);
    await store_wrapped_deks(wrapped_source, wrapped_target);
    const destroy = vi.spyOn(EnvelopeKeyService.prototype, 'destroy');

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).rejects.toThrow(WrongPassphraseError);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('zero-fills both unwrapped DEKs after a successful comparison (issue #436)', async () => {
    const writer = new EnvelopeKeyService(passphrase);
    const dek = writer.generate_dek();
    const wrapped = await writer.wrap_dek(dek, tenant_id);
    await store_wrapped_deks(wrapped, wrapped);

    const unwrapped: Buffer[] = [];
    const real_unwrap = EnvelopeKeyService.prototype.unwrap_dek;
    vi.spyOn(EnvelopeKeyService.prototype, 'unwrap_dek').mockImplementation(async function (
      this: EnvelopeKeyService,
      blob: Buffer,
      tid: string,
    ) {
      const result = await real_unwrap.call(this, blob, tid);
      unwrapped.push(result);
      return result;
    });

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).resolves.toBeUndefined();

    expect(unwrapped).toHaveLength(2);
    for (const key of unwrapped) expect(key.every((byte) => byte === 0)).toBe(true);
  });

  it('zero-fills both unwrapped DEKs when they differ', async () => {
    const writer = new EnvelopeKeyService(passphrase);
    const wrapped_a = await writer.wrap_dek(writer.generate_dek(), tenant_id);
    const wrapped_b = await writer.wrap_dek(writer.generate_dek(), tenant_id);
    await store_wrapped_deks(wrapped_a, wrapped_b);

    const unwrapped: Buffer[] = [];
    const real_unwrap = EnvelopeKeyService.prototype.unwrap_dek;
    vi.spyOn(EnvelopeKeyService.prototype, 'unwrap_dek').mockImplementation(async function (
      this: EnvelopeKeyService,
      blob: Buffer,
      tid: string,
    ) {
      const result = await real_unwrap.call(this, blob, tid);
      unwrapped.push(result);
      return result;
    });

    await expect(
      validate_dek_match(source_storage, target_storage, passphrase, tenant_id),
    ).rejects.toThrow(DekMismatchError);

    expect(unwrapped).toHaveLength(2);
    for (const key of unwrapped) expect(key.every((byte) => byte === 0)).toBe(true);
  });
});
