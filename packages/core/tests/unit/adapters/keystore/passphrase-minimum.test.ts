import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { ConfigError } from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { DEFAULT_KDF_STRATEGY } from '@/adapters/keystore/kdf-strategy';
import { build_header_bytes } from '@/adapters/keystore/dek-blob-codec';
import { logger } from '@/utils/logger';

const TENANT = 'tenant-1';

/** Wraps a DEK the way releases before #447 did, so a short-passphrase blob can exist. */
async function legacy_wrap(passphrase: string, dek: Buffer): Promise<Buffer> {
  const params = DEFAULT_KDF_STRATEGY.generate_params();
  const header = build_header_bytes({ kdf_id: DEFAULT_KDF_STRATEGY.kdf_id, kdf_params: params });
  const kek = await DEFAULT_KDF_STRATEGY.derive_kek(Buffer.from(passphrase), params, TENANT);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: 16 });
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('passphrase minimum for tenant keys (issue #447)', () => {
  it('refuses to wrap a key under fewer than 14 UTF-8 bytes', async () => {
    const svc = new EnvelopeKeyService('thirteen-byte');

    await expect(svc.wrap_dek(svc.generate_dek(), TENANT)).rejects.toBeInstanceOf(ConfigError);
  });

  it('counts bytes, not characters, at the boundary', async () => {
    // Seven two-byte characters: 7 characters, 14 bytes.
    const svc = new EnvelopeKeyService('äääääää');
    const dek = svc.generate_dek();

    const wrapped = await svc.wrap_dek(dek, TENANT);

    expect(await svc.unwrap_dek(wrapped, TENANT)).toEqual(dek);
  });

  it('still opens a key wrapped under a short passphrase, and warns', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const dek = randomBytes(32);
    const blob = await legacy_wrap('abcd', dek);

    const opened = await new EnvelopeKeyService('abcd').unwrap_dek(blob, TENANT);

    expect(opened).toEqual(dek);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shorter than 14 UTF-8 bytes'));
  });
});
