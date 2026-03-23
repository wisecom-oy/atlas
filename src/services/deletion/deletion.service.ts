import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { DeletionResult, DeletionUseCase } from '@/ports/deletion/use-case.port';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import { logger } from '@/utils/logger';

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
  async delete_mailbox_data(tenant_id: string, mailbox_id: string): Promise<DeletionResult> {
    mailbox_id = mailbox_id.toLowerCase();
    const ctx = await this._tenant_factory.create(tenant_id);
    return delete_prefixes(ctx.storage, [
      `manifests/${mailbox_id}/`,
      `data/${mailbox_id}/`,
      `attachments/${mailbox_id}/`,
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
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);

    if (!manifest) {
      return empty_deletion_result();
    }

    const key = `manifests/${manifest.mailbox_id}/${manifest.snapshot_id}.json`;
    const summary = await delete_prefixes(ctx.storage, [key]);
    if (summary.retained_manifests > 0 || summary.failed_manifests > 0) {
      logger.error('Snapshot manifest is protected by Object Lock and cannot be deleted yet.');
    }
    return summary;
  }

  /**
   * Removes everything in the tenant bucket: data, attachments, manifests, and _meta
   * (including the encrypted DEK). This is irreversible.
   */
  async purge_tenant(tenant_id: string): Promise<DeletionResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const core = await delete_prefixes(ctx.storage, ['manifests/', 'data/', 'attachments/']);
    if (
      core.retained_objects > 0 ||
      core.retained_manifests > 0 ||
      core.failed_objects > 0 ||
      core.failed_manifests > 0
    ) {
      return core;
    }

    const meta = await delete_prefixes(ctx.storage, ['_meta/']);
    return {
      deleted_objects: core.deleted_objects + meta.deleted_objects,
      deleted_manifests: core.deleted_manifests + meta.deleted_manifests,
      retained_objects: core.retained_objects + meta.retained_objects,
      retained_manifests: core.retained_manifests + meta.retained_manifests,
      failed_objects: core.failed_objects + meta.failed_objects,
      failed_manifests: core.failed_manifests + meta.failed_manifests,
    };
  }
}

/** Deletes all versions (or current keys) under the provided prefixes/keys. */
async function delete_prefixes(
  storage: {
    delete(key: string): Promise<void>;
    list(prefix: string): Promise<string[]>;
    list_versions(prefix: string): Promise<{ key: string; version_id: string }[]>;
    delete_version(key: string, version_id: string): Promise<void>;
  },
  scopes: string[],
): Promise<DeletionResult> {
  const summary = empty_deletion_result();

  for (const scope of scopes) {
    const version_entries = await storage.list_versions(scope);
    if (version_entries.length > 0) {
      for (const version of version_entries) {
        try {
          await storage.delete_version(version.key, version.version_id);
          if (version.key.startsWith('manifests/')) summary.deleted_manifests++;
          else summary.deleted_objects++;
        } catch (err) {
          if (is_object_lock_delete_error(err)) {
            if (version.key.startsWith('manifests/')) summary.retained_manifests++;
            else summary.retained_objects++;
            continue;
          }
          if (version.key.startsWith('manifests/')) summary.failed_manifests++;
          else summary.failed_objects++;
        }
      }
      continue;
    }

    const visible_keys = await storage.list(scope);
    for (const key of visible_keys) {
      try {
        await storage.delete(key);
        if (key.startsWith('manifests/')) summary.deleted_manifests++;
        else summary.deleted_objects++;
      } catch (err) {
        if (is_object_lock_delete_error(err)) {
          if (key.startsWith('manifests/')) summary.retained_manifests++;
          else summary.retained_objects++;
          continue;
        }
        if (key.startsWith('manifests/')) summary.failed_manifests++;
        else summary.failed_objects++;
      }
    }
  }
  return summary;
}

function is_object_lock_delete_error(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name} ${err.message}`.toLowerCase() : '';
  return (
    message.includes('object lock') ||
    message.includes('retention') ||
    message.includes('worm protected') ||
    message.includes('accessdenied') ||
    message.includes('operationaborted')
  );
}

function empty_deletion_result(): DeletionResult {
  return {
    deleted_objects: 0,
    deleted_manifests: 0,
    retained_objects: 0,
    retained_manifests: 0,
    failed_objects: 0,
    failed_manifests: 0,
  };
}
