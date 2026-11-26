import type { StorageDeleteOutcome, StorageObjectVersion } from '@wisecom/atlas-types';
import {
  empty_tally,
  tally_outcome,
  type DeletionTally,
} from '@/services/deletion/shared/deletion-tally';
import {
  delete_entries_in_batches,
  type BatchDeletionStorage,
  type DeletableEntry,
  type DeletionOutcomeObserver,
} from '@/services/deletion/shared/version-batch-deleter';

/** One object version a prune deletes, with its size when the listing reported it. */
export interface PrunableVersion extends DeletableEntry {
  readonly size_bytes?: number | undefined;
}

/** The counts a prune adds up across its steps: what it deleted, or would delete in a dry run. */
export class PruneTally {
  readonly counts: DeletionTally = empty_tally();
  deleted_bytes = 0;

  /** Counts one version's outcome, and its bytes when it was deleted. */
  record(version: PrunableVersion, outcome: StorageDeleteOutcome): void {
    tally_outcome(this.counts, version, outcome);
    if (outcome === 'deleted' && version.is_delete_marker !== true) {
      this.deleted_bytes += version.size_bytes ?? 0;
    }
  }

  /** Counts how a dry run expects deleting this version to end. */
  record_planned(version: PrunableVersion, outcome: StorageDeleteOutcome): void {
    this.record(version, outcome);
  }
}

/** The storage calls a prune's listings use. */
export interface VersionListingStorage {
  list(prefix: string): Promise<string[]>;
  list_versions(prefix: string): Promise<readonly StorageObjectVersion[]>;
  readonly list_version_pages?:
    ((prefix: string) => AsyncIterable<readonly StorageObjectVersion[]>) | undefined;
}

/**
 * Every version and delete marker under a prefix, a listing page at a time where the storage can
 * page. A backend that lists no versions yields the visible keys instead, as the owner deletes do.
 */
export async function* versions_under(
  storage: VersionListingStorage,
  prefix: string,
): AsyncGenerator<PrunableVersion> {
  let listed = 0;
  if (storage.list_version_pages) {
    for await (const page of storage.list_version_pages(prefix)) {
      listed += page.length;
      yield* page;
    }
  } else {
    const versions = await storage.list_versions(prefix);
    listed = versions.length;
    yield* versions;
  }
  if (listed > 0) return;
  for (const key of await storage.list(prefix)) yield { key };
}

/** How a dry run expects deleting one version to end. */
export type OutcomePrediction = (version: PrunableVersion) => StorageDeleteOutcome;

/** What `settle_versions` does with each version, and who hears of the outcome. */
export interface Settlement {
  readonly dry_run: boolean;
  /** A dry run's expected outcome per version; deleted when not given. */
  readonly predict?: OutcomePrediction | undefined;
  readonly observe?: DeletionOutcomeObserver<PrunableVersion> | undefined;
}

/**
 * Deletes every version the stream yields and counts each outcome, or in a dry run only counts
 * the outcome it predicts. `observe` sees each version's outcome either way.
 */
export async function settle_versions(
  storage: BatchDeletionStorage,
  versions: AsyncIterable<PrunableVersion>,
  tally: PruneTally,
  settlement: Settlement,
): Promise<void> {
  const { observe } = settlement;
  if (settlement.dry_run) {
    for await (const version of versions) {
      const outcome = settlement.predict?.(version) ?? 'deleted';
      tally.record_planned(version, outcome);
      observe?.(version, outcome);
    }
    return;
  }
  await delete_entries_in_batches(storage, versions, (version, outcome) => {
    tally.record(version, outcome);
    observe?.(version, outcome);
  });
}
