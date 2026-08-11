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
 */
export function resolve_destination_library(
  library_name: string | undefined,
  target_libraries: readonly SharePointDocumentLibrary[],
): SharePointDocumentLibrary | undefined {
  if (library_name) {
    const wanted = library_name.toLowerCase();
    const match = target_libraries.find((lib) => lib.drive_name.toLowerCase() === wanted);
    if (match) return match;
  }

  // Single-library site: the destination is unambiguous whatever it is called.
  if (target_libraries.length === 1) return target_libraries[0];

  return undefined;
}

/** Explains an unresolved destination, listing what the target site does offer. */
export function describe_unresolved_destination(
  file_name: string,
  library_name: string | undefined,
  target_libraries: readonly SharePointDocumentLibrary[],
): string {
  const source = library_name ? `library "${library_name}"` : 'an unnamed library';
  const candidates = target_libraries.map((lib) => `"${lib.drive_name}"`).join(', ');
  return (
    `${file_name}: no destination library in the target site matches ${source} ` +
    `(target has ${candidates}). Create a library with that name, or restore ` +
    `with --file-filter into a site that has one.`
  );
}
