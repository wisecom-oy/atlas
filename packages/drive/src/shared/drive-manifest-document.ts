import { UnreadableObjectsError } from '@wisecom/atlas-types';
import { is_json_record } from '@wisecom/atlas-core/services/shared/stored-json-reader';
import {
  require_manifest_entry_parts,
  type ManifestEntryParts,
} from '@/shared/manifest-part-document';
import type { DriveStorageKeys } from '@/shared/storage-keys';

/** What the store needs from either provider's manifest. */
export interface DriveStoredManifest {
  readonly snapshot_id: string;
  readonly created_at: Date;
}

/**
 * How one provider names and lays out its manifests. They differ only in the namespace and in
 * the field that names the owning segment (`owner_id` on OneDrive, `site_id` on SharePoint).
 */
export interface DriveManifestLayout {
  /** Provider name for operator-facing messages, e.g. `OneDrive`. */
  readonly label: string;
  readonly keys: DriveStorageKeys;
  readonly owner_field: 'owner_id' | 'site_id';
}

/** A parsed manifest document: either every entry inline, or a head that lists entry parts. */
export type ParsedManifestDocument =
  | { readonly body: Record<string, unknown>; readonly entries: unknown[] }
  | { readonly body: Record<string, unknown>; readonly entry_parts: ManifestEntryParts };

/**
 * The shape, identity and date checks of a parsed manifest body, shared by reader and writer.
 * Returns the manifest with `created_at` revived as a Date.
 */
export function require_drive_manifest<T extends DriveStoredManifest>(
  layout: DriveManifestLayout,
  parsed: unknown,
  key: string,
): T {
  const label = `${layout.label} manifest`;
  if (!is_json_record(parsed) || !Array.isArray(parsed.entries)) {
    throw new UnreadableObjectsError(`The ${label} is not a manifest`, [key]);
  }
  return { ...(parsed as unknown as T), created_at: require_identity(layout, parsed, key) };
}

/**
 * The checks of {@link require_drive_manifest} for a body that may also be the head of a
 * multi-part manifest (#920), which carries `entry_parts` in place of `entries`.
 */
export function require_drive_manifest_document(
  layout: DriveManifestLayout,
  parsed: unknown,
  key: string,
): ParsedManifestDocument {
  if (!is_json_record(parsed)) {
    throw new UnreadableObjectsError(`The ${layout.label} manifest is not a manifest`, [key]);
  }
  if (Array.isArray(parsed.entries)) {
    require_identity(layout, parsed, key);
    return { body: parsed, entries: parsed.entries };
  }
  if (!('entry_parts' in parsed)) {
    throw new UnreadableObjectsError(`The ${layout.label} manifest is not a manifest`, [key]);
  }
  require_identity(layout, parsed, key);
  return { body: parsed, entry_parts: require_manifest_entry_parts(parsed.entry_parts, key) };
}

/** Requires the body to name the key it was read from and to carry a valid `created_at`. */
function require_identity(
  layout: DriveManifestLayout,
  parsed: Record<string, unknown>,
  key: string,
): Date {
  const label = `${layout.label} manifest`;
  if (rebuilt_key(layout, parsed) !== key) {
    const named = `${String(parsed[layout.owner_field])}/${String(parsed.snapshot_id)}`;
    throw new UnreadableObjectsError(
      `The ${label} decrypts to ${named}; ` +
        `refusing to use a manifest that is not the one the key names`,
      [key],
    );
  }
  const created_at = new Date(parsed.created_at as string);
  if (typeof parsed.created_at !== 'string' || Number.isNaN(created_at.getTime())) {
    throw new UnreadableObjectsError(`Invalid created_at in the ${label}`, [key]);
  }
  return created_at;
}

/** The key a parsed body claims to live under; undefined when its identity fields are unusable. */
function rebuilt_key(
  layout: DriveManifestLayout,
  body: Record<string, unknown>,
): string | undefined {
  const owner = body[layout.owner_field];
  if (typeof owner !== 'string' || typeof body.snapshot_id !== 'string') return undefined;
  try {
    return layout.keys.manifest_key(owner, body.snapshot_id);
  } catch {
    return undefined;
  }
}
