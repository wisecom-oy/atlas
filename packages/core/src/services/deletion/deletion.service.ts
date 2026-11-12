import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { HeldOwnerLease, OwnerLeasePort, TenantContextFactory } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { DeletionResult, DeletionUseCase } from '@wisecom/atlas-types';
import {
  MANIFEST_REPOSITORY_TOKEN,
  NotFoundError,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  delete_scopes,
  has_survivors,
  merge_deletion_results,
} from '@/services/deletion/shared/prefix-deleter';
import {
  erase_leased_owner_scopes,
  run_owner_erasure,
} from '@/services/deletion/shared/leased-owner-deletion';
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
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Deletes all data objects, attachment objects, and manifests for a single mailbox.
   * Manifests are deleted first so an interrupted deletion leaves orphan data
   * objects (harmless) rather than manifests referencing deleted objects.
   *
   * Runs under the mailbox's lease, so it is refused with `OwnerBusyError` while a backup of the
   * mailbox is running (issue #623).
   */
  async delete_mailbox_data(tenant_id: string, owner_id: string): Promise<DeletionResult> {
    owner_id = normalize_owner_id(owner_id);
    return run_owner_erasure(
      { tenant_factory: this._tenant_factory, leases: this._leases },
      tenant_id,
      { workload: 'outlook', owner_id },
      async (storage, lease) => {
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

        return erase_leased_owner_scopes(storage, lease, [
          manifest_prefix,
          ...snapshot_pointers,
          `${OUTLOOK_MANIFEST_POINTER_PREFIX}/owners/${owner_id}/`,
          outlook_cursor_key(owner_id),
          ...replication_status_prefixes(owner_id, snapshot_ids),
          `data/${owner_id}/`,
          `attachments/${owner_id}/`,
          ...quarantined_copies_of([manifest_prefix]),
        ]);
      },
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
   * The mailbox is only known once the manifest is read, so the lease is taken after that read.
   * The order check runs under it: a backup cannot add a newer snapshot in between (issue #623).
   */
  async delete_snapshot(tenant_id: string, snapshot_id: string): Promise<DeletionResult> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    let lease: HeldOwnerLease | undefined;
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);

      if (!manifest) {
        throw new NotFoundError(`No manifest found for snapshot ${snapshot_id}`);
      }
      lease = await this._leases.acquire(ctx, {
        workload: 'outlook',
        owner_id: normalize_owner_id(manifest.owner_id),
        operation: 'delete',
      });
      await assert_outlook_snapshot_is_newest(this._manifests, ctx, manifest);
      lease.assert_held();

      const key = `manifests/${manifest.owner_id}/${manifest.snapshot_id}.json`;
      const manifest_summary = await delete_scopes(ctx.storage, [key]);
      if (has_survivors(manifest_summary)) {
        if (manifest_summary.retained_manifests > 0 || manifest_summary.failed_manifests > 0) {
          logger.error('Snapshot manifest is protected by Object Lock and cannot be deleted yet.');
        }
        return manifest_summary;
      }

      const pointer_summary = await delete_scopes(ctx.storage, [
        `${OUTLOOK_MANIFEST_POINTER_PREFIX}/snapshots/${snapshot_id}.json`,
        `${OUTLOOK_MANIFEST_POINTER_PREFIX}/owners/${manifest.owner_id}/latest.json`,
        outlook_cursor_key(manifest.owner_id),
      ]);
      return merge_deletion_results(manifest_summary, pointer_summary);
    } finally {
      await lease?.release();
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
   */
  async purge_tenant(tenant_id: string): Promise<DeletionResult> {
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);

    const data = await delete_scopes(storage, [''], [DEK_KEY]);
    if (has_survivors(data)) {
      logger.error('Tenant purge left objects behind; keeping the DEK so they stay recoverable.');
      return data;
    }

    const dek = await delete_scopes(storage, [DEK_KEY]);
    return merge_deletion_results(data, dek);
  }
}
