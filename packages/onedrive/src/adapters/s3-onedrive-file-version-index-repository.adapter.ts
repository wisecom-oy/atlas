import { injectable } from 'inversify';
import type {
  OneDriveFileVersionIndex,
  OneDriveFileVersionIndexRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  onedrive_index_prefix,
  onedrive_run_index_key,
  validate_key_segment,
} from '@/services/onedrive-storage-keys';

/** Payload of one run's version index object. */
interface RunIndexPayload {
  owner_id: string;
  snapshot_id: string;
  indexes: OneDriveFileVersionIndex[];
}

/**
 * Either a per-run payload or a legacy per-file index written before
 * issue #161. Both stay readable so history recorded by older Atlas versions
 * remains visible until those objects are purged.
 */
type StoredIndexPayload = RunIndexPayload | OneDriveFileVersionIndex;

/**
 * S3-backed version index with one object per backup run
 * (`onedrive/index/<owner>/runs/<snapshot_id>.json`). A 20,000-file drive
 * costs one PUT and one small object per run instead of one object per file,
 * each billed at the provider's minimum size floor (issue #161).
 */
@injectable()
export class S3OneDriveFileVersionIndexRepository implements OneDriveFileVersionIndexRepository {
  /** Version ids already recorded per file id across the owner's index objects. */
  async load_known_version_ids(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<Map<string, Set<string>>> {
    const indexes = await this.list_by_owner(ctx, owner_id);
    const known = new Map<string, Set<string>>();
    for (const idx of indexes) {
      known.set(
        idx.file_id,
        new Set(idx.versions.map((v) => v.version_id).filter(Boolean) as string[]),
      );
    }
    return known;
  }

  /** Writes the run's captured rows as a single create-only index object; no-op when empty. */
  async write_run_index(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
    indexes: OneDriveFileVersionIndex[],
  ): Promise<void> {
    if (indexes.length === 0) return;
    validate_key_segment(snapshot_id);
    const payload: RunIndexPayload = { owner_id, snapshot_id, indexes };
    await ctx.storage.put(
      onedrive_run_index_key(owner_id, snapshot_id),
      ctx.encrypt(Buffer.from(JSON.stringify(payload), 'utf-8')),
    );
  }

  /** Retrieves the merged version history for a specific file across all index objects. */
  async find_by_file_id(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
  ): Promise<OneDriveFileVersionIndex | undefined> {
    const keys = await ctx.storage.list(onedrive_index_prefix(owner_id));
    const versions: OneDriveFileVersionIndex['versions'] = [];
    for (const key of keys) {
      for (const idx of await this.download_indexes(ctx, key)) {
        if (idx.file_id === file_id) versions.push(...idx.versions);
      }
    }
    if (versions.length === 0) return undefined;
    return { file_id, owner_id, versions: sort_versions(versions) };
  }

  /** Lists per-file version histories for an owner, merged across all index objects. */
  async list_by_owner(ctx: TenantContext, owner_id: string): Promise<OneDriveFileVersionIndex[]> {
    const keys = await ctx.storage.list(onedrive_index_prefix(owner_id));
    const by_file = new Map<string, OneDriveFileVersionIndex>();
    for (const key of keys) {
      for (const idx of await this.download_indexes(ctx, key)) {
        merge_index(by_file, idx);
      }
    }
    return [...by_file.values()];
  }

  /**
   * Downloads one index object and yields its per-file indexes. Storage or
   * parse failures yield nothing for that object, matching the previous
   * per-file behaviour of skipping unreadable entries.
   */
  private async download_indexes(
    ctx: TenantContext,
    key: string,
  ): Promise<OneDriveFileVersionIndex[]> {
    try {
      const payload = await ctx.storage.get(key);
      const parsed = JSON.parse(ctx.decrypt(payload).toString('utf-8')) as StoredIndexPayload;
      return 'indexes' in parsed ? parsed.indexes : [parsed];
    } catch {
      return [];
    }
  }
}

function merge_index(
  by_file: Map<string, OneDriveFileVersionIndex>,
  idx: OneDriveFileVersionIndex,
): void {
  const existing = by_file.get(idx.file_id);
  const merged = sort_versions(existing ? [...existing.versions, ...idx.versions] : idx.versions);
  by_file.set(idx.file_id, { file_id: idx.file_id, owner_id: idx.owner_id, versions: merged });
}
function sort_versions(versions: OneDriveFileVersionIndex['versions']): typeof versions {
  return [...versions].sort((a, b) =>
    a.backup_at < b.backup_at ? -1 : a.backup_at > b.backup_at ? 1 : 0,
  );
}
