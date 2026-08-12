import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { DeletionResult, DeletionUseCase } from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN, MANIFEST_REPOSITORY_TOKEN } from '@wisecom/atlas-types';
import {
  delete_scopes,
  empty_deletion_result,
  has_survivors,
  merge_deletion_results,
} from '@/services/deletion/shared/prefix-deleter';
import { logger } from '@/utils/logger';

/**
 * The wrapped DEK, deleted last so a blocked purge stays recoverable.
 *
 * Held back as this exact key, not as the whole `_meta/` prefix: replica markers
 * and replication status records share that tree and are themselves encrypted
 * with the DEK, so they have to go before the key that reads them.
 */
const DEK_KEY = '_meta/dek.enc';

@injectable()
export class DeletionService implements DeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Deletes all data objects, attachment objects, and manifests for a single mailbox.
   * Manifests are deleted first so an interrupted deletion leaves orphan data
   * objects (harmless) rather than manifests referencing deleted objects.
   */
  async delete_mailbox_data(tenant_id: string, owner_id: string): Promise<DeletionResult> {
    owner_id = normalize_owner_id(owner_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_scopes(storage, [
      `manifests/${owner_id}/`,
      `data/${owner_id}/`,
      `attachments/${owner_id}/`,
    ]);
  }

  /**
   * Deletes a single snapshot manifest. Data objects are intentionally kept
   * because delta manifests are not self-contained -- other manifests in the
   * chain may reference the same objects. Use `delete_mailbox_data` to remove
   * all objects for a mailbox, or `purge_tenant` for everything.
   */
  async delete_snapshot(tenant_id: string, snapshot_id: string): Promise<DeletionResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);

      if (!manifest) {
        return empty_deletion_result();
      }

      const key = `manifests/${manifest.owner_id}/${manifest.snapshot_id}.json`;
      const summary = await delete_scopes(ctx.storage, [key]);
      if (summary.retained_manifests > 0 || summary.failed_manifests > 0) {
        logger.error('Snapshot manifest is protected by Object Lock and cannot be deleted yet.');
      }
      return summary;
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
