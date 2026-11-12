import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  Manifest,
  ObjectStorage,
  OwnerLeases,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { DeletionResult, DeletionUseCase } from '@wisecom/atlas-types';
import {
  MANIFEST_REPOSITORY_TOKEN,
  NotFoundError,
  OWNER_LEASES_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  delete_scopes,
  has_survivors,
  merge_deletion_results,
} from '@/services/deletion/shared/prefix-deleter';
import { delete_under_owner_lease } from '@/services/deletion/shared/leased-deletion';
import { TENANT_LEASE_KEY } from '@/services/lease/lease-record';
import { logger } from '@/utils/logger';
import { quarantined_copies_of } from '@/services/quarantine/stored-object-quarantine';
import { assert_outlook_snapshot_is_newest } from '@/services/deletion/outlook-snapshot-order-guard';

/**
 * The wrapped DEK, deleted last so a blocked purge stays recoverable.
 *
 * Held back as this exact key, not as the whole `_meta/` prefix: replica markers
 * and replication status records share that tree and are themselves encrypted
 * with the DEK, so they have to go before the key that reads them.
 */
const DEK_KEY = '_meta/dek.enc';
const OUTLOOK_MANIFEST_POINTER_PREFIX = '_meta/outlook-manifests';

/** The mailbox's delta cursor, written by `S3MailboxDeltaCursorRepository`. */
function outlook_cursor_key(owner_id: string): string {
  return `_meta/outlook-cursors/${owner_id}.json`;
}

/**
 * Replication status records of the given Outlook snapshots. Only these snapshots' folders: the
 * `_meta/replication/{owner_id}/` tree is shared with the OneDrive backup of the same user.
 */
function replication_status_prefixes(owner_id: string, snapshot_ids: Iterable<string>): string[] {
  return [...snapshot_ids].map((snapshot_id) => `_meta/replication/${owner_id}/${snapshot_id}/`);
}

@injectable()
export class DeletionService implements DeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(OWNER_LEASES_TOKEN) private readonly _leases: OwnerLeases,
  ) {}

  /**
   * Deletes all data objects, attachment objects, and manifests for a single mailbox.
   * Manifests are deleted first so an interrupted deletion leaves orphan data
   * objects (harmless) rather than manifests referencing deleted objects.
   */
  async delete_mailbox_data(tenant_id: string, owner_id: string): Promise<DeletionResult> {
    owner_id = normalize_owner_id(owner_id);
    const deps = { tenant_factory: this._tenant_factory, leases: this._leases };
    return delete_under_owner_lease(deps, tenant_id, 'outlook', owner_id, (storage) =>
      delete_mailbox_objects(storage, owner_id),
    );
  }

  /**
   * Deletes the mailbox's newest snapshot manifest, then its pointers and the delta cursor.
   *
   * Data objects are intentionally kept because delta manifests are not self-contained: other
   * manifests in the chain may reference the same objects. Any other snapshot is refused with
   * `SnapshotNotNewestError`, since newer snapshots fold in the changes it recorded (issue #704).
   * The cursor goes because it points past the deleted run; without it the next backup resumes
   * from the remaining head manifest's own links. Use `delete_mailbox_data` to remove all objects
   * for a mailbox, or `purge_tenant` for everything.
   *
   * The newest-snapshot check runs under the mailbox's lease, so a backup cannot add a newer
   * snapshot between the check and the delete.
   */
  async delete_snapshot(tenant_id: string, snapshot_id: string): Promise<DeletionResult> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);

      if (!manifest) {
        throw new NotFoundError(`No manifest found for snapshot ${snapshot_id}`);
      }
      const scope = {
        workload: 'outlook',
        owner_id: manifest.owner_id,
        operation: 'delete',
      } as const;
      return await this._leases.run_exclusive(ctx, scope, (leased) =>
        this.delete_newest_snapshot(leased, manifest),
      );
    } finally {
      ctx.destroy();
    }
  }

  /**
   * Removes every object in the tenant bucket, including the encrypted DEK.
   * This is irreversible.
   *
   * The sweep covers the whole bucket rather than a list of known prefixes.
   * Each workload owns its own tree -- Outlook at the root, OneDrive and
   * SharePoint under theirs, plus loose keys like the identity registry -- and
   * an enumerated list silently stops erasing whatever ships next (issue #27).
   *
   * The DEK goes last and only if nothing survived: dropping the key while its
   * ciphertext is still retained would leave data that can neither be restored
   * nor claimed erased.
   *
   * Runs under the tenant lease, so it refuses while any backup, restore or deletion is running
   * and every such run refuses while it purges.
   */
  async purge_tenant(tenant_id: string): Promise<DeletionResult> {
    const storage_ctx = await this._tenant_factory.create_storage_only(tenant_id);
    const purged = await this._leases.run_tenant_exclusive(storage_ctx, 'purge', ({ storage }) =>
      purge_bucket(storage),
    );
    if (has_survivors(purged)) return purged;
    // The purge's own lease, every version of it, once released, so an erased bucket is empty.
    const lease = await delete_scopes(storage_ctx.storage, [TENANT_LEASE_KEY]);
    return merge_deletion_results(purged, lease);
  }

  /** Refuses a snapshot that is not the newest, then deletes it with its pointers and cursor. */
  private async delete_newest_snapshot(
    ctx: TenantContext,
    manifest: Manifest,
  ): Promise<DeletionResult> {
    await assert_outlook_snapshot_is_newest(this._manifests, ctx, manifest);
    return delete_snapshot_objects(ctx.storage, manifest.owner_id, manifest.snapshot_id);
  }
}

/** Deletes every manifest, pointer, cursor, data and attachment object of one mailbox. */
async function delete_mailbox_objects(
  storage: ObjectStorage,
  owner_id: string,
): Promise<DeletionResult> {
  const manifest_prefix = `manifests/${owner_id}/`;
  const [manifest_keys, manifest_versions] = await Promise.all([
    storage.list(manifest_prefix),
    storage.list_versions(manifest_prefix),
  ]);
  const snapshot_ids = new Set<string>();
  for (const key of [...manifest_keys, ...manifest_versions.map((version) => version.key)]) {
    if (!key.startsWith(manifest_prefix) || !key.endsWith('.json')) continue;
    const snapshot_id = key.slice(manifest_prefix.length, -'.json'.length);
    if (snapshot_id.length > 0) snapshot_ids.add(snapshot_id);
  }
  const snapshot_pointers = [...snapshot_ids].map(
    (snapshot_id) => `${OUTLOOK_MANIFEST_POINTER_PREFIX}/snapshots/${snapshot_id}.json`,
  );

  return delete_scopes(storage, [
    manifest_prefix,
    ...snapshot_pointers,
    `${OUTLOOK_MANIFEST_POINTER_PREFIX}/owners/${owner_id}/`,
    outlook_cursor_key(owner_id),
    ...replication_status_prefixes(owner_id, snapshot_ids),
    `data/${owner_id}/`,
    `attachments/${owner_id}/`,
    ...quarantined_copies_of([manifest_prefix]),
  ]);
}

/** Deletes one snapshot manifest, then its pointers and the mailbox cursor once it is gone. */
async function delete_snapshot_objects(
  storage: ObjectStorage,
  owner_id: string,
  snapshot_id: string,
): Promise<DeletionResult> {
  const key = `manifests/${owner_id}/${snapshot_id}.json`;
  const manifest_summary = await delete_scopes(storage, [key]);
  if (has_survivors(manifest_summary)) {
    if (manifest_summary.retained_manifests > 0 || manifest_summary.failed_manifests > 0) {
      logger.error('Snapshot manifest is protected by Object Lock and cannot be deleted yet.');
    }
    return manifest_summary;
  }

  const pointer_summary = await delete_scopes(storage, [
    `${OUTLOOK_MANIFEST_POINTER_PREFIX}/snapshots/${snapshot_id}.json`,
    `${OUTLOOK_MANIFEST_POINTER_PREFIX}/owners/${owner_id}/latest.json`,
    outlook_cursor_key(owner_id),
  ]);
  return merge_deletion_results(manifest_summary, pointer_summary);
}

/** Empties the bucket except the purge's own lease: data first, then the DEK if nothing survived. */
async function purge_bucket(storage: ObjectStorage): Promise<DeletionResult> {
  const data = await delete_scopes(storage, [''], [DEK_KEY, TENANT_LEASE_KEY]);
  if (has_survivors(data)) {
    logger.error('Tenant purge left objects behind; keeping the DEK so they stay recoverable.');
    return data;
  }

  const dek = await delete_scopes(storage, [DEK_KEY]);
  return merge_deletion_results(data, dek);
}
