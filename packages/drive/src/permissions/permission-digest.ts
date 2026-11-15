import { createHash } from 'node:crypto';
import type { DrivePermission } from '@wisecom/atlas-types';

/**
 * A stable fingerprint of an item's permissions, so a re-presented item whose sharing did not
 * change writes no entry. Order-insensitive: Graph does not promise the order it lists them in.
 */
export function digest_permissions(permissions: readonly DrivePermission[]): string {
  const canonical = permissions.map((permission) => canonical_json(permission)).sort();
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/** JSON with object keys sorted at every level, so equal permissions serialize identically. */
function canonical_json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical_json(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical_json(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
