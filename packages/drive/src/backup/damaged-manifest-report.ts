/**
 * Every damaged manifest a drive backup run saw, each key once: the keys the head lookup named,
 * then the keys the re-crawl comparison skipped.
 *
 * A drive run resumes from its delta cursor and needs no manifest, so an incremental run used to
 * read none and reported a damaged newest manifest as healthy with exit 0, while Outlook named it
 * and exited 9 (issue #709). Each run therefore looks up the head the way Outlook does, before it
 * writes its own manifest, which would otherwise become the head and hide the damaged one. A
 * re-crawl reads every manifest as well, so the two lists can name the same key.
 */
export function merge_damaged_manifest_keys(
  head_keys: readonly string[],
  recrawl_keys: readonly string[],
): string[] {
  return [...new Set([...head_keys, ...recrawl_keys])];
}
