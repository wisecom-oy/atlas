import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type { TenantContext } from '@wisecom/atlas-types';

/** Encrypts and stores bytes under `key` unless the object already exists. Returns true when written. */
export async function put_content_if_absent(
  ctx: TenantContext,
  key: string,
  plaintext: Buffer,
): Promise<boolean> {
  if (await ctx.storage.exists(key)) return false;
  await ctx.storage.put(key, ctx.encrypt(plaintext, key));
  return true;
}

/** Reads and decrypts one content object. */
export async function read_content(ctx: TenantContext, key: string): Promise<Buffer> {
  return ctx.decrypt(await ctx.storage.get(key), key);
}

/** Throws when decrypted bytes do not hash to the recorded checksum (plain SHA-256). */
export function assert_checksum(
  ctx: TenantContext,
  data: Buffer,
  expected: string,
  label: string,
): void {
  if (compute_content_digests(ctx, data).checksum !== expected) {
    throw new Error(`${label} failed its checksum`);
  }
}
