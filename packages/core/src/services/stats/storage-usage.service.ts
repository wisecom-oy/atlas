import { inject, injectable } from 'inversify';
import {
  ConfigError,
  MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  STORAGE_INVENTORY_FACTORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  LogicalWorkload,
  ManifestRepository,
  OneDriveManifestRepository,
  SharePointManifestRepository,
  StorageInventoryFactory,
  StorageTarget,
  StorageUsage,
  StorageUsageRequest,
  StorageUsageWorkload,
  StorageUsageUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { logger } from '@/utils/logger';
import { aggregate_bucket_stats } from '@/services/stats/stats-aggregator';
import { run_usage_listing } from '@/services/stats/storage-usage-run';
import {
  decode_state,
  encode_state,
  fresh_state,
  is_complete,
  type UsageState,
} from '@/services/stats/storage-usage-state';
import { owner_rows, sum_counts, to_totals } from '@/services/stats/storage-usage-tally';

type LogicalBytes = Record<LogicalWorkload, number>;

const WORKLOAD_ORDER: readonly StorageUsageWorkload[] = [
  'outlook',
  'onedrive',
  'sharepoint',
  'meta',
  'other',
];

@injectable()
export class StorageUsageService implements StorageUsageUseCase {
  constructor(
    @inject(STORAGE_INVENTORY_FACTORY_TOKEN)
    private readonly _open_inventory: StorageInventoryFactory,
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _od_manifests: OneDriveManifestRepository,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _sp_manifests: SharePointManifestRepository,
  ) {}

  /**
   * Lists the bucket (or the target's copy of it) and reports what it holds. Stops early on the
   * request allowance or the abort signal and returns a continuation token instead of throwing.
   */
  async measure_storage_usage(
    tenant_id: string,
    request: StorageUsageRequest = {},
  ): Promise<StorageUsage> {
    validate_request(request);
    const identity = {
      tenant_id,
      target_id: request.target?.target_id ?? 'primary',
      breakdown: request.breakdown ?? 'workload',
    };
    const state = request.continuation_token
      ? decode_state(request.continuation_token, identity)
      : fresh_state(identity, new Date());
    const inventory = request.target
      ? request.target.open_inventory(tenant_id)
      : this._open_inventory(tenant_id);

    await run_usage_listing(state, inventory, {
      max_requests: request.max_list_requests,
      signal: request.abort_signal,
    });

    const complete = is_complete(state);
    const logical = complete ? await this.read_logical_bytes(tenant_id, request.target) : undefined;
    return build_report(state, complete, logical);
  }

  /**
   * Sums the logical sizes every stored manifest references, the totals `stats` reports. Needs
   * the data key, so a bucket that holds no backups, or a replica without its key, has none; the
   * report then omits the figure rather than failing the measurement it already has.
   */
  private async read_logical_bytes(
    tenant_id: string,
    target?: StorageTarget,
  ): Promise<LogicalBytes | undefined> {
    let ctx: TenantContext | undefined;
    try {
      ctx = target
        ? await target.create_context(tenant_id)
        : await this._tenant_factory.create_readonly(tenant_id);
      const outlook = await this._manifests.list_all_manifests(ctx);
      const onedrive = await this._od_manifests.list_all_manifests(ctx);
      const sharepoint = await this._sp_manifests.list_all_manifests(ctx);
      return {
        outlook: aggregate_bucket_stats(tenant_id, outlook).total_size_bytes,
        onedrive: onedrive.reduce((sum, manifest) => sum + manifest.total_size_bytes, 0),
        sharepoint: sharepoint.reduce((sum, manifest) => sum + manifest.total_size_bytes, 0),
      };
    } catch (err) {
      logger.warn(`Logical size not reported: manifests could not be read (${String(err)})`);
      return undefined;
    } finally {
      ctx?.destroy();
    }
  }
}

/** Options arrive from SDK callers as untyped JavaScript; refuse what would mislead the run. */
function validate_request(request: StorageUsageRequest): void {
  const { breakdown, max_list_requests, continuation_token } = request;
  if (breakdown !== undefined && breakdown !== 'workload' && breakdown !== 'owner') {
    throw new ConfigError(`breakdown must be "workload" or "owner", got ${String(breakdown)}.`);
  }
  if (
    max_list_requests !== undefined &&
    (!Number.isSafeInteger(max_list_requests) || max_list_requests < 1)
  ) {
    throw new ConfigError('maxListRequests must be a positive integer.');
  }
  if (
    continuation_token !== undefined &&
    (typeof continuation_token !== 'string' || !continuation_token)
  ) {
    throw new ConfigError('continuationToken must be a nonempty string.');
  }
}

function build_report(
  state: UsageState,
  complete: boolean,
  logical: LogicalBytes | undefined,
): StorageUsage {
  const totals = sum_counts(Object.values(state.by_workload));
  return {
    target: state.target_id,
    started_at: state.started_at,
    measured_at: new Date().toISOString(),
    complete,
    ...(complete ? {} : { continuation_token: encode_state(state) }),
    versions_visible: state.versions_visible,
    incomplete_uploads_visible: state.uploads.visible,
    list_requests: state.requests,
    stored_bytes: totals.current_bytes + totals.noncurrent_bytes + totals.upload_bytes,
    totals: to_totals(totals),
    // Listing order depends on which prefix finished first; the report does not.
    by_workload: Object.fromEntries(
      WORKLOAD_ORDER.flatMap((workload) => {
        const counts = state.by_workload[workload];
        return counts ? [[workload, to_totals(counts)]] : [];
      }),
    ),
    ...(state.by_owner ? { by_owner: owner_rows(state.by_owner) } : {}),
    ...(logical
      ? {
          logical_bytes_referenced: logical.outlook + logical.onedrive + logical.sharepoint,
          logical_bytes_by_workload: logical,
        }
      : {}),
  };
}
