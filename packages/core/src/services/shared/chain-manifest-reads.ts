import type { UnreadableContentError } from '@wisecom/atlas-types';
import { read_each_readable } from '@/services/shared/readable-object-listing';

const CHAIN_READ_CONCURRENCY = 8;

/** The older manifests a chain read, and the listed ones it could not use. */
export interface ChainManifestReads<TManifest> {
  readonly manifests: TManifest[];
  /** Listed keys whose manifest failed to decrypt or parse, or was gone by the time it was read. */
  readonly refused_keys: string[];
  /** Why the first damaged manifest could not be read; absent when every refused key was gone. */
  readonly first_error: UnreadableContentError | undefined;
}

/**
 * Reads the older manifests the summary index lists for a chain.
 *
 * Every listed key is a link the chain needs. The summary reader returns rows only for keys its
 * listing found, so a key that reads as absent was removed after that listing, by quarantine, an
 * owner delete or lifecycle expiry. Folding the chain without it would answer with fewer items
 * and without the removals it recorded, so an absent link is refused like a damaged one rather
 * than dropped (issue #714).
 */
export async function read_chain_manifests<TManifest>(
  keys: readonly string[],
  read: (key: string) => Promise<TManifest | undefined>,
): Promise<ChainManifestReads<TManifest>> {
  const absent: string[] = [];
  const listing = await read_each_readable(
    keys,
    async (key) => {
      const manifest = await read(key);
      if (manifest === undefined) absent.push(key);
      return manifest;
    },
    CHAIN_READ_CONCURRENCY,
  );
  return {
    manifests: listing.items,
    refused_keys: [...listing.unreadable_keys, ...absent.sort()],
    first_error: listing.unreadable_errors[0],
  };
}
