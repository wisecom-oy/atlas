import { inject, injectable } from 'inversify';
import type {
  OneDriveDeletionUseCase,
  TenantContextFactory,
  DeletionResult,
} from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';

@injectable()
export class OneDriveDeletionService implements OneDriveDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
  ) {}

  /** Deletes all backed-up OneDrive data for a single owner. */
  async delete_owner_data(tenant_id: string, owner_id: string): Promise<DeletionResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      return await delete_prefixes(ctx.storage, [
        `onedrive/manifests/${owner_id}/`,
        `onedrive/data/${owner_id}/`,
        `onedrive/index/${owner_id}/`,
        `onedrive/_meta/${owner_id}/`,
      ]);
    } finally {
      ctx.destroy();
    }
  }

  /**
   * Deletes a single OneDrive snapshot manifest. Blob objects are retained because
   * other snapshots may reference the same content-addressed keys.
   */
  async delete_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const key = `onedrive/manifests/${owner_id}/${snapshot_id}.json`;
      const summary = empty_deletion_summary();
      await delete_single_key(ctx.storage, key, summary);
      return { ...summary };
    } finally {
      ctx.destroy();
    }
  }
}

interface DeletionStorage {
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

type DeletionSummaryMutable = {
  deleted_objects: number;
  deleted_manifests: number;
  retained_objects: number;
  retained_manifests: number;
  failed_objects: number;
  failed_manifests: number;
};

/** Lists and deletes all keys under the provided prefixes. */
async function delete_prefixes(
  storage: DeletionStorage,
  prefixes: string[],
): Promise<DeletionResult> {
  const summary = empty_deletion_summary();

  for (const prefix of prefixes) {
    const keys = await storage.list(prefix);
    for (const key of keys) {
      await delete_single_key(storage, key, summary);
    }
  }

  return { ...summary };
}

async function delete_single_key(
  storage: DeletionStorage,
  key: string,
  summary: DeletionSummaryMutable,
): Promise<void> {
  try {
    await storage.delete(key);
    increment_summary(summary, key, 'deleted');
  } catch (err) {
    const bucket = is_object_lock_delete_error(err) ? 'retained' : 'failed';
    increment_summary(summary, key, bucket);
  }
}

function increment_summary(
  summary: DeletionSummaryMutable,
  key: string,
  outcome: 'deleted' | 'retained' | 'failed',
): void {
  const suffix = key.startsWith('onedrive/manifests/') ? 'manifests' : 'objects';
  const field = `${outcome}_${suffix}` as keyof DeletionSummaryMutable;
  summary[field]++;
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

function empty_deletion_summary(): DeletionSummaryMutable {
  return {
    deleted_objects: 0,
    deleted_manifests: 0,
    retained_objects: 0,
    retained_manifests: 0,
    failed_objects: 0,
    failed_manifests: 0,
  };
}
