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
 */

/** Normalizes a mailbox, owner, or site identifier used as a storage key segment. */
export function normalize_owner_id(value: string): string {
  return value.toLowerCase();
}
