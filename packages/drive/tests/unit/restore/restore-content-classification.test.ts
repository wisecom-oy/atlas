/**
 * How the shared drive restore reader names a file it cannot restore. Each reason reaches the
 * run's error list, so damage must read as damage and a storage or KMS failure must not
 * (issues #76, #712).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { StoredBlobRef, TenantContext } from '@wisecom/atlas-types';
import { DAMAGED_OBJECT_REASON, read_restore_content } from '@/restore/restore-content-read';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CONTENT = Buffer.from('quarterly-report');
const DEK = randomBytes(32);

/** Produces the stored envelope: [IV (12)] [auth tag (16)] [ciphertext]. */
function encrypt(plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', DEK, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(blob: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', DEK, blob.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

const ENTRY = {
  file_id: 'file-1',
  file_name: 'report.docx',
  size_bytes: CONTENT.length,
  storage_key: 'sharepoint/data/site-1/file-1',
  checksum: createHash('sha256').update(CONTENT).digest('hex'),
} as StoredBlobRef;

function make_ctx(get: () => Promise<Buffer>): TenantContext {
  return { storage: { get }, decrypt } as unknown as TenantContext;
}

/** The reason the reader gave, or a failure when it returned content. */
async function unrestorable_reason(ctx: TenantContext, ref = ENTRY): Promise<string> {
  const read = await read_restore_content(ctx, ref);
  if (read.kind !== 'unrestorable') throw new Error('expected the file to be unrestorable');
  return read.reason;
}

describe('read_restore_content classification', () => {
  it('returns verified content for an intact object', async () => {
    const read = await read_restore_content(
      make_ctx(async () => encrypt(CONTENT)),
      ENTRY,
    );

    expect(read).toEqual({ kind: 'readable', content: CONTENT });
  });

  it('names a tampered object as damage, not as a wrong key', async () => {
    const blob = encrypt(CONTENT);
    blob[blob.length - 1] ^= 0xff;

    await expect(unrestorable_reason(make_ctx(async () => blob))).resolves.toBe(
      DAMAGED_OBJECT_REASON,
    );
  });

  it('names content that decrypts but does not match its checksum', async () => {
    const reason = await unrestorable_reason(make_ctx(async () => encrypt(Buffer.from('other'))));

    expect(reason).toMatch(/SHA-256 checksum/);
  });

  it('names an object that is gone from storage as missing', async () => {
    const absent = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
    });

    await expect(unrestorable_reason(make_ctx(() => Promise.reject(absent)))).resolves.toBe(
      'stored object is missing',
    );
  });

  it('reports a storage authorization failure as a read failure, not tampering', async () => {
    const ctx = make_ctx(() =>
      Promise.reject(new Error('AccessDenied: the request authorization has expired')),
    );

    const reason = await unrestorable_reason(ctx);

    expect(reason).toMatch(/^stored object could not be read: AccessDenied/);
    expect(reason).not.toBe(DAMAGED_OBJECT_REASON);
  });

  it('does not treat a decrypt-stage error mentioning auth as tampering', async () => {
    const ctx = {
      storage: { get: async () => encrypt(CONTENT) },
      decrypt: () => {
        throw new Error('Authentication token for the KMS proxy expired');
      },
    } as unknown as TenantContext;

    await expect(unrestorable_reason(ctx)).resolves.toMatch(
      /^stored object could not be decrypted/,
    );
  });

  it('refuses an entry with no recorded checksum without reading it', async () => {
    const get = vi.fn(async () => encrypt(CONTENT));

    const reason = await unrestorable_reason(make_ctx(get), { ...ENTRY, checksum: undefined });

    expect(reason).toMatch(/no checksum/);
    expect(get).not.toHaveBeenCalled();
  });
});
