/**
 * Destination routing for cross-site restores.
 *
 * A manifest entry records the `drive_id` of the library it was backed up
 * from. That id is only meaningful inside the source site: Graph addresses an
 * upload as `/sites/{site}/drives/{drive}/...` and the drive id wins, so
 * reusing it while pointing at another site writes into the *source* library.
 * A cross-site restore therefore has to pick a library that belongs to the
 * target site, and must refuse rather than guess when it cannot.
 *
 * Library names are locale-dependent (a Finnish tenant's default library is
 * `Tiedostot`, an English one's is `Documents`), so an exact name match cannot
 * be the only rule -- the common single-library case is resolved by position
 * instead.
 */

import type { SharePointDocumentLibrary } from '@wisecom/atlas-types';

/**
 * Picks the library in `target_libraries` that should receive an entry backed
 * up from `library_name`. Returns undefined when the choice is ambiguous.
 *
 * `single_source_library` says whether everything being restored came from one
 * library. Only then may an unmatched name fall through to a lone target
 * library: collapsing several source libraries into one destination merges
 * their trees, and two files sharing a drive-relative path would land on top of
 * each other -- destroying the restore's own output under `--conflict replace`.
 */
export function resolve_destination_library(
  library_name: string | undefined,
  target_libraries: readonly SharePointDocumentLibrary[],
  single_source_library: boolean,
): SharePointDocumentLibrary | undefined {
  if (library_name) {
    const wanted = fold_name(library_name);
    const matches = target_libraries.filter((lib) => fold_name(lib.drive_name) === wanted);
    // Two libraries can carry the same display name; picking either is a guess.
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }

  // Single-library site: the destination is unambiguous whatever it is called.
  if (single_source_library && target_libraries.length === 1) return target_libraries[0];

  return undefined;
}

/**
 * Folds a library name for comparison. NFC because Graph returns whatever form
 * the client that created the library used, and `toLowerCase` rather than its
 * locale-aware twin, which maps `I` to a dotless `i` under a Turkish locale.
 */
function fold_name(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** Explains an unresolved destination, listing what the target site does offer. */
export function describe_unresolved_destination(
  library_name: string | undefined,
  target_libraries: readonly SharePointDocumentLibrary[],
  single_source_library: boolean,
): string {
  const source = library_name ? `library "${library_name}"` : 'an unnamed library';
  const candidates = target_libraries.map((lib) => `"${lib.drive_name}"`).join(', ');
  const remedy = single_source_library
    ? 'Restore into a site whose library carries that name, or into a site with a single document library.'
    : 'This snapshot spans several libraries, so it cannot be folded into one destination: restore it into a site whose libraries carry the same names, or one library at a time with --file-filter.';
  return (
    `No library in the target site matches source ${source} (target has ${candidates}); ` +
    `its files were skipped. ${remedy}`
  );
}
