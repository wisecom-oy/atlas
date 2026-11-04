import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import {
  UnreadableContentError,
  type TeamsGraphResource,
  type TeamsStoredBlobRef,
  type TenantContext,
} from '@wisecom/atlas-types';

/**
 * Reads one stored blob and checks its plaintext against the recorded SHA-256. Throws when the
 * object is missing or does not match, so the export reports it instead of writing bad data.
 * Messages carry no storage key in the error text: the caller labels the failure instead.
 */
export async function read_verified_blob(
  ctx: TenantContext,
  ref: TeamsStoredBlobRef,
): Promise<Buffer> {
  let encrypted: Buffer;
  try {
    encrypted = await ctx.storage.get(ref.storage_key);
  } catch (err) {
    if (is_absent_object_error(err)) {
      throw new UnreadableContentError('blob is missing from storage', { cause: err });
    }
    throw err;
  }
  const plaintext = ctx.decrypt(encrypted, ref.storage_key);
  if (compute_content_digests(ctx, plaintext).checksum !== ref.checksum) {
    throw new UnreadableContentError('blob does not match its recorded checksum');
  }
  return plaintext;
}

/** Reads a stored Graph message or tombstone as parsed JSON. */
export async function read_message_content(
  ctx: TenantContext,
  ref: TeamsStoredBlobRef,
): Promise<TeamsGraphResource> {
  const plaintext = await read_verified_blob(ctx, ref);
  return JSON.parse(plaintext.toString('utf8')) as TeamsGraphResource;
}
