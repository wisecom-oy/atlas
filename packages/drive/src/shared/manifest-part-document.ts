import type { TenantCryptoContext } from '@wisecom/atlas-types';
import { UnreadableObjectsError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { is_json_record } from '@wisecom/atlas-core/services/shared/stored-json-reader';

/** The layout version of `entry_parts` this build writes and reads. */
export const MANIFEST_PARTS_VERSION = 1;

/** What the head of a multi-part manifest records about one of its entry parts. */
export interface ManifestPartReference {
  readonly entry_count: number;
  /** Keyed HMAC-SHA256 of the part's plaintext, so a substituted or stale part is refused. */
  readonly digest: string;
}

/** The field a multi-part manifest head carries instead of `entries` (#920). */
export interface ManifestEntryParts {
  readonly version: number;
  readonly entry_count: number;
  readonly parts: readonly ManifestPartReference[];
}

/** Which manifest and which position one part belongs to; its body repeats all of it. */
export interface ManifestPartIdentity {
  /** `owner_id` on OneDrive, `site_id` on SharePoint. */
  readonly owner_field: string;
  readonly owner_id: string;
  readonly snapshot_id: string;
  readonly part_index: number;
}

/**
 * Builds the JSON text of one entry part from entries already serialised, so the part is the only
 * string built and the whole manifest never is.
 */
export function build_manifest_part_text(
  identity: ManifestPartIdentity,
  entry_texts: readonly string[],
): string {
  const header = JSON.stringify({
    [identity.owner_field]: identity.owner_id,
    snapshot_id: identity.snapshot_id,
    part_index: identity.part_index,
  });
  return `${header.slice(0, -1)},"entries":[${entry_texts.join(',')}]}`;
}

/** Keyed digest of a part's plaintext under the tenant's content HMAC key. */
export function digest_part_text(ctx: TenantCryptoContext, text: string | Buffer): string {
  return ctx.create_content_hmac().update(text).digest('hex');
}

/** Rebuilds the key a part lives under from the owner, snapshot and position its body names. */
export type ManifestPartKeyOf = (
  owner_id: string,
  snapshot_id: string,
  part_index: number,
) => string;

/**
 * Returns a parsed part's entries after checking that the owner, snapshot and position its body
 * names rebuild the key it was read from. A part copied to another snapshot, owner or position is
 * refused, the same way a manifest is (issue #340).
 */
export function require_manifest_part_entries(
  parsed: unknown,
  owner_field: string,
  key_of: ManifestPartKeyOf,
  key: string,
): unknown[] {
  if (!is_json_record(parsed) || !Array.isArray(parsed.entries)) {
    throw new UnreadableObjectsError('The manifest part is not a manifest part', [key]);
  }
  if (rebuilt_part_key(parsed, owner_field, key_of) !== key) {
    throw new UnreadableObjectsError(
      'The manifest part names another snapshot or position than its key',
      [key],
    );
  }
  return parsed.entries;
}

function rebuilt_part_key(
  body: Record<string, unknown>,
  owner_field: string,
  key_of: ManifestPartKeyOf,
): string | undefined {
  const owner = body[owner_field];
  const { snapshot_id, part_index } = body;
  if (typeof owner !== 'string' || typeof snapshot_id !== 'string') return undefined;
  if (typeof part_index !== 'number') return undefined;
  try {
    return key_of(owner, snapshot_id, part_index);
  } catch {
    return undefined;
  }
}

/**
 * Checks the `entry_parts` field of a manifest head. A version this build does not know raises
 * `UnsupportedFormatVersionError`: the head is intact and a newer Atlas reads it.
 */
export function require_manifest_entry_parts(value: unknown, key: string): ManifestEntryParts {
  if (!is_json_record(value) || typeof value.version !== 'number') {
    throw new UnreadableObjectsError('The manifest head has no valid entry_parts', [key]);
  }
  if (value.version !== MANIFEST_PARTS_VERSION) {
    throw new UnsupportedFormatVersionError(
      `The manifest at ${key} uses entry part layout version ${value.version}, which this ` +
        'Atlas does not read; upgrade Atlas to read it',
    );
  }
  const parts = value.parts;
  if (!Array.isArray(parts) || !parts.every(is_part_reference)) {
    throw new UnreadableObjectsError('The manifest head lists malformed entry parts', [key]);
  }
  const counted = parts.reduce((sum, part) => sum + part.entry_count, 0);
  if (value.entry_count !== counted) {
    throw new UnreadableObjectsError('The manifest head counts its entries inconsistently', [key]);
  }
  return { version: value.version, entry_count: counted, parts };
}

function is_part_reference(value: unknown): value is ManifestPartReference {
  return (
    is_json_record(value) &&
    Number.isSafeInteger(value.entry_count) &&
    (value.entry_count as number) >= 0 &&
    typeof value.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.digest)
  );
}
