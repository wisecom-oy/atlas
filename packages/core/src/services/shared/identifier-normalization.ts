/**
 * One rule for the identifiers that become storage key segments.
 *
 * A mailbox address, an Entra object ID, and a SharePoint site ID are all
 * case-insensitive to Microsoft but case-sensitive to S3. Passing two spellings
 * of one identifier used to write two prefixes: the same drive backed up twice,
 * and a delete that reported success against whichever spelling it was handed
 * while the other survived (issue #38).
 *
 * Graph returns these lowercase already, so this only bites callers who supply
 * their own -- an operator pasting an object ID from a portal, or an SDK
 * embedder holding it in application state.
 *
 * Applies ONLY to owner-style identifiers. Graph item IDs (`file_id`,
 * `item_id`) are genuinely case-sensitive and must never pass through here.
 *
 * The SDK publishes these rules through `@wisecom/atlas-sdk/contract`, so an
 * inventory kept in a browser or a Worker keys owners the way the workload
 * services do (issue #830). It imports nothing: other packages' tests load it
 * from source, and the contract must bundle for a browser or a Worker.
 */

/** The shape of an Entra or Graph GUID, in either case. */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalizes a mailbox, owner, or site identifier used as a storage key segment. */
export function normalize_owner_id(value: string): string {
  return value.toLowerCase();
}

/**
 * The storage form of a Teams team id: trimmed and lowercased, or undefined when that is not a
 * GUID. Graph ids are GUIDs and storage keys embed the id verbatim, so a URL, a stray space, or an
 * uppercase copy would otherwise create a second prefix for the same team.
 */
export function parse_team_id(value: string): string | undefined {
  const team_id = value.trim().toLowerCase();
  return GUID_RE.test(team_id) ? team_id : undefined;
}
