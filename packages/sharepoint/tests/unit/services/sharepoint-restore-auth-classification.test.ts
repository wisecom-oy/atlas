import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SharePointManifestEntry, TenantContext } from '@wisecom/atlas-types';
import {
  download_and_decrypt,
  SharePointDecryptAuthError,
} from '@/services/sharepoint-restore-content';

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

const ENTRY: SharePointManifestEntry = {
  file_id: 'file-1',
  drive_id: 'drive-1',
  file_name: 'report.docx',
  parent_path: '/Documents',
  size_bytes: CONTENT.length,
  change_type: 'created',
  backup_at: '2026-08-17T00:00:00.000Z',
  storage_key: 'sharepoint/data/site-1/file-1',
  checksum: createHash('sha256').update(CONTENT).digest('hex'),
};

function make_ctx(get: () => Promise<Buffer>): TenantContext {
  return { storage: { get }, decrypt } as unknown as TenantContext;
}

describe('SharePoint restore error classification', () => {
  it('reports a tampered blob as an AES-GCM authentication failure', async () => {
    const blob = encrypt(CONTENT);
    blob[blob.length - 1] ^= 0xff;
    await expect(
      download_and_decrypt(
        make_ctx(async () => blob),
        ENTRY,
      ),
    ).rejects.toThrow(SharePointDecryptAuthError);
  });

  it('reports a storage authorization failure as a storage error, not tampering', async () => {
    const ctx = make_ctx(() =>
      Promise.reject(new Error('AccessDenied: the request authorization has expired')),
    );
    await expect(download_and_decrypt(ctx, ENTRY)).resolves.toBeUndefined();
  });

  it('does not treat a decrypt-stage error mentioning auth as tampering', async () => {
    const ctx = {
      storage: { get: async () => encrypt(CONTENT) },
      decrypt: () => {
        throw new Error('Authentication token for the KMS proxy expired');
      },
    } as unknown as TenantContext;
    await expect(download_and_decrypt(ctx, ENTRY)).resolves.toBeUndefined();
  });
});
