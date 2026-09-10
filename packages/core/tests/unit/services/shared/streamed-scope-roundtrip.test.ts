import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { stream_to_content_addressed_storage } from '@/services/shared/stream-encrypt-upload';
import { stream_decrypt_from_storage } from '@/services/shared/stream-decrypt';

/**
 * Issue #350: the streamed path encrypts into a staging key and promotes the object onto a
 * content-addressed key, so it has to bind the directory it ends up in rather than the one it is
 * written to. If it bound the staging key the object would be unreadable the moment it was
 * promoted, which no unit test of the cipher alone would catch.
 */

const OWNER = 'owner-1';
const DATA_SCOPE = `onedrive/data/${OWNER}/`;

/** An in-memory bucket with just enough multipart to assemble what the writer uploads. */
function make_ctx(): { ctx: TenantContext; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const key_service = new EnvelopeKeyService('test-passphrase');
  const dek = key_service.generate_dek();

  const storage = {
    begin_multipart_upload: async (key: string) => {
      const parts = new Map<number, Buffer>();
      return {
        upload_part: async (part_number: number, data: Buffer) => {
          parts.set(part_number, Buffer.from(data));
          return `etag-${part_number}`;
        },
        complete: async () => {
          const assembled = [...parts.entries()].sort(([a], [b]) => a - b).map(([, data]) => data);
          objects.set(key, Buffer.concat(assembled));
        },
        abort: async () => parts.clear(),
      };
    },
    exists: async (key: string) => objects.has(key),
    copy: async (from: string, to: string) => {
      objects.set(to, objects.get(from)!);
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    get: async (key: string) => objects.get(key)!,
    get_stream: async (key: string) => Readable.from([objects.get(key)!]),
    abort_incomplete_uploads: async () => 0,
    list_stale: async () => [],
  };

  const ctx = {
    tenant_id: 'tenant-1',
    storage,
    encrypt: (data: Buffer, storage_key: string) => key_service.encrypt(data, dek, storage_key),
    decrypt: (data: Buffer, storage_key: string) => key_service.decrypt(data, dek, storage_key),
    create_cipher: (scope_key: string) => key_service.create_encrypt_cipher(dek, scope_key),
    create_decipher: (iv: Buffer, auth_tag: Buffer, scope_key: string, header?: Buffer) =>
      key_service.create_decrypt_decipher(dek, iv, auth_tag, scope_key, header),
    destroy: () => key_service.destroy(),
  } as unknown as TenantContext;

  return { ctx, objects };
}

describe('streamed object scope binding (issue #350)', () => {
  it('decrypts from the canonical key it was promoted onto', async () => {
    const { ctx, objects } = make_ctx();
    const plaintext = randomBytes(64 * 1024);

    const result = await stream_to_content_addressed_storage(
      ctx,
      (async function* () {
        yield plaintext;
      })(),
      {
        staging_key: `onedrive/staging/${OWNER}/item-1-a1b2`,
        build_data_key: (checksum) => `${DATA_SCOPE}${checksum}`,
        data_scope: DATA_SCOPE,
      },
    );

    expect(result.stored).toBe(true);
    const read_back = await stream_decrypt_from_storage(ctx, result.storage_key);
    expect(read_back.content).toEqual(plaintext);

    // The same bytes under another owner's prefix authenticate nowhere.
    objects.set(`onedrive/data/owner-2/stolen`, objects.get(result.storage_key)!);
    await expect(
      stream_decrypt_from_storage(ctx, 'onedrive/data/owner-2/stolen'),
    ).rejects.toThrow();
  });

  it('reads a buffered object back from the key it was written to', async () => {
    const { ctx, objects } = make_ctx();
    const key = `${DATA_SCOPE}buffered`;
    const plaintext = Buffer.from('small enough for a single put');

    objects.set(key, ctx.encrypt(plaintext, key));

    expect(ctx.decrypt(objects.get(key)!, key)).toEqual(plaintext);
    expect(() => ctx.decrypt(objects.get(key)!, 'onedrive/data/owner-2/buffered')).toThrow();
  });
});
