import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { is_json_record } from '@wisecom/atlas-core/services/shared/stored-json-reader';
import type { CursorItemMaps } from '@/shared/cursor-item-buckets';
import type { DriveStorageKeys } from '@/shared/storage-keys';

/** The layout version of `item_parts` this build writes and reads. */
export const CURSOR_PARTS_VERSION = 1;

/** How one provider names and lays out its delta cursor. */
export interface DriveCursorLayout {
  /** Operator-facing name, e.g. `OneDrive delta cursor`. */
  readonly label: string;
  readonly keys: DriveStorageKeys;
  /** `owner_id` on OneDrive, `site_id` on SharePoint. */
  readonly owner_field: 'owner_id' | 'site_id';
}

/** The field a multi-part cursor head carries in place of its item maps (#920). */
export interface CursorItemParts {
  readonly version: number;
  /** The item map fields the cursor had; an absent field stays absent when it is read back. */
  readonly fields: readonly string[];
  readonly bucket_count: number;
  /** The content name of each bucket's part, in bucket order. */
  readonly parts: readonly string[];
}

/** The parsed body of one cursor part. */
export interface CursorPartBody {
  readonly bucket: number;
  readonly bucket_count: number;
  readonly maps: CursorItemMaps;
}

/** Builds the JSON text of one bucket's part; the owner field names the cursor it belongs to. */
export function build_cursor_part_text(
  owner_field: string,
  owner_id: string,
  part: CursorPartBody,
): string {
  return JSON.stringify({ [owner_field]: owner_id, ...part });
}

/** The owner value a cursor head or part names, or undefined when it names none. */
export function owner_named_by(body: unknown, owner_field: string): string | undefined {
  if (!is_json_record(body)) return undefined;
  const owner = body[owner_field];
  return typeof owner === 'string' ? owner : undefined;
}

/**
 * Checks a parsed part: it names the owner and part key it was read from, and the bucket the head
 * expects. Raises `UnreadableContentError`, the error an unreadable cursor raises.
 */
export function require_cursor_part(
  parsed: unknown,
  layout: DriveCursorLayout,
  expected: { readonly key: string; readonly part_name: string; readonly bucket: number },
  bucket_count: number,
): CursorPartBody {
  const owner = owner_named_by(parsed, layout.owner_field);
  const names_key =
    owner !== undefined &&
    part_key_or_undefined(layout, owner, expected.part_name) === expected.key;
  if (
    !names_key ||
    !is_json_record(parsed) ||
    parsed.bucket !== expected.bucket ||
    parsed.bucket_count !== bucket_count ||
    !is_json_record(parsed.maps) ||
    !Object.values(parsed.maps).every(is_json_record)
  ) {
    throw new UnreadableContentError(
      `The ${layout.label} part at ${expected.key} is not bucket ${expected.bucket} of this cursor`,
    );
  }
  return parsed as unknown as CursorPartBody;
}

/**
 * Checks the `item_parts` field of a cursor head. A version this build does not know raises
 * `UnsupportedFormatVersionError`, so the head is never overwritten by an older Atlas.
 */
export function require_cursor_item_parts(value: unknown, key: string): CursorItemParts {
  if (!is_json_record(value) || typeof value.version !== 'number') {
    throw new UnreadableContentError(`The delta cursor head at ${key} has no valid item_parts`);
  }
  if (value.version !== CURSOR_PARTS_VERSION) {
    throw new UnsupportedFormatVersionError(
      `The delta cursor at ${key} uses part layout version ${value.version}, which this Atlas ` +
        'does not read; upgrade Atlas to read it',
    );
  }
  const { fields, bucket_count, parts } = value;
  const valid =
    Array.isArray(fields) &&
    fields.every((field) => typeof field === 'string') &&
    typeof bucket_count === 'number' &&
    Array.isArray(parts) &&
    parts.length === bucket_count &&
    parts.every((name) => typeof name === 'string' && /^[0-9a-f]{64}$/.test(name));
  if (!valid) {
    throw new UnreadableContentError(`The delta cursor head at ${key} lists malformed parts`);
  }
  return value as unknown as CursorItemParts;
}

function part_key_or_undefined(
  layout: DriveCursorLayout,
  owner: string,
  part_name: string,
): string | undefined {
  try {
    return layout.keys.delta_cursor_part_key(owner, part_name);
  } catch {
    return undefined;
  }
}
