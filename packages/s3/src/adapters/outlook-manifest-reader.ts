import type { Manifest, TenantContext } from '@wisecom/atlas-types';
import {
  is_json_record,
  read_encrypted_json,
} from '@wisecom/atlas-core/services/shared/stored-json-reader';
import {
  InvalidManifestDateError,
  MalformedManifestError,
  MismatchedManifestError,
} from '@/adapters/manifest.errors';

export const OUTLOOK_MANIFEST_PREFIX = 'manifests';

/** Constructs the S3 key for a manifest. */
export function outlook_manifest_key(owner_id: string, snapshot_id: string): string {
  return `${OUTLOOK_MANIFEST_PREFIX}/${owner_id}/${snapshot_id}.json`;
}

/**
 * Downloads an encrypted manifest blob, decrypts it, revives `created_at` as a Date, and rejects
 * a body the key does not name. `undefined` means the object is absent.
 *
 * A manifest is encrypted with the tenant key and nothing in the ciphertext says which manifest
 * it is, so any manifest in the tenant authenticates at any other manifest's key. Rebuilding the
 * key from the decrypted body is what distinguishes them, and doing it here covers the legacy
 * scan and the listing paths as well as the pointer lookups (issue #340).
 *
 * A fetch failure raises `StorageError`. A manifest that fails to decrypt, parse or identify
 * raises `UnreadableContentError`, which a listing skips and names (issues #341, #631).
 */
export async function read_outlook_manifest(
  ctx: TenantContext,
  key: string,
): Promise<Manifest | undefined> {
  const parsed = await read_encrypted_json(ctx, key, 'Outlook manifest');
  if (parsed === undefined) return undefined;
  if (!has_manifest_fields(parsed)) throw new MalformedManifestError(key);
  if (outlook_manifest_key(parsed.owner_id, parsed.snapshot_id) !== key) {
    throw new MismatchedManifestError(key, parsed.owner_id, parsed.snapshot_id);
  }
  const created_at = new Date(parsed.created_at);
  if (Number.isNaN(created_at.getTime())) throw new InvalidManifestDateError(key);
  return { ...(parsed as unknown as Manifest), created_at };
}

/** The fields every Outlook manifest has carried since the first release. */
function has_manifest_fields(value: unknown): value is {
  owner_id: string;
  snapshot_id: string;
  created_at: string;
  entries: unknown[];
} {
  return (
    is_json_record(value) &&
    typeof value.owner_id === 'string' &&
    typeof value.snapshot_id === 'string' &&
    typeof value.created_at === 'string' &&
    Array.isArray(value.entries)
  );
}
