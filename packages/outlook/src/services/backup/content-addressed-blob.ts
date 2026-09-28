import { createHash } from 'node:crypto';
import type { ObjectLockPolicy, TenantContext } from '@wisecom/atlas-types';

export interface StoredBlob {
  readonly storage_key: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly new_object: boolean;
}

/** Encrypts and uploads a payload under `{prefix}/{sha256}` unless that object already exists. */
export async function store_content_addressed_blob(
  ctx: TenantContext,
  prefix: string,
  payload: Buffer,
  policy?: ObjectLockPolicy,
): Promise<StoredBlob> {
  const checksum = createHash('sha256').update(payload).digest('hex');
  const storage_key = `${prefix}/${checksum}`;
  const exists = await ctx.storage.exists(storage_key);
  if (!exists) await ctx.storage.put(storage_key, ctx.encrypt(payload, storage_key), {}, policy);
  return { storage_key, checksum, size_bytes: payload.length, new_object: !exists };
}
