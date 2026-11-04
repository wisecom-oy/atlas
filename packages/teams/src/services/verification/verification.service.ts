import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import {
  NotFoundError,
  TEAMS_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TeamsStoredBlobRef,
  TeamsVerificationResult,
  TeamsVerificationUseCase,
  TenantContext,
  TenantContextFactory,
  VerificationOptions,
} from '@wisecom/atlas-types';
import { normalize_team_id } from '@/services/shared/team-id';
import { thread_stored_blobs } from '@/services/shared/thread-blobs';

/** Every blob a snapshot references: thread blobs, hosted contents, and last live blobs. */
function collect_blob_refs(manifest: TeamsSnapshotManifest): TeamsStoredBlobRef[] {
  return manifest.channels.flatMap((channel) =>
    Object.values(channel.threads).flatMap(thread_stored_blobs),
  );
}

/**
 * Downloads, decrypts, and hashes one blob. A missing object or one that fails to decrypt or
 * hash to its recorded checksum counts as a failure. Other storage errors propagate.
 */
async function blob_matches(ctx: TenantContext, ref: TeamsStoredBlobRef): Promise<boolean> {
  let encrypted: Buffer;
  try {
    encrypted = await ctx.storage.get(ref.storage_key);
  } catch (err) {
    if (is_absent_object_error(err)) {
      return false;
    }
    throw err;
  }
  try {
    const plaintext = ctx.decrypt(encrypted, ref.storage_key);
    return (
      plaintext.length === ref.size_bytes &&
      compute_content_digests(ctx, plaintext).checksum === ref.checksum
    );
  } catch {
    return false;
  }
}

@injectable()
export class TeamsVerificationService implements TeamsVerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: TeamsManifestRepository,
  ) {}

  /**
   * Checks every blob a snapshot references against its recorded size and SHA-256 checksum.
   * `fast` checks only that each blob exists, and progress is reported per blob.
   */
  async verify_teams_snapshot(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<TeamsVerificationResult> {
    const normalized_team_id = normalize_team_id(team_id);
    if (begin_operation_progress(options, 'verify', 'teams')) {
      finish_operation_progress(options, 'verify', 'teams', 0, 0);
      return {
        snapshot_id,
        total_checked: 0,
        passed: 0,
        failed_storage_keys: [],
        interrupted: true,
        index_issues: [],
      };
    }
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, normalized_team_id, snapshot_id);
      if (manifest === undefined) {
        throw new NotFoundError(
          `Teams snapshot ${snapshot_id} not found for team ${normalized_team_id}`,
        );
      }
      const refs = collect_blob_refs(manifest);
      emit_operation_progress(options, {
        operation: 'verify',
        workload: 'teams',
        phase: 'processing',
        processed: 0,
        total: refs.length,
      });
      const { failed_storage_keys, total_checked } = await this.check_blobs(ctx, refs, options);
      const interrupted = finish_operation_progress(
        options,
        'verify',
        'teams',
        total_checked,
        refs.length,
        total_checked < refs.length,
      );
      return {
        snapshot_id,
        total_checked,
        passed: total_checked - failed_storage_keys.length,
        failed_storage_keys,
        interrupted,
        index_issues: [],
      };
    } finally {
      ctx.destroy();
    }
  }

  /** Checks blobs one at a time in manifest order, stopping early when interrupted. */
  private async check_blobs(
    ctx: TenantContext,
    refs: TeamsStoredBlobRef[],
    options: VerificationOptions,
  ): Promise<{ failed_storage_keys: string[]; total_checked: number }> {
    const failed_storage_keys: string[] = [];
    let total_checked = 0;
    for (const ref of refs) {
      if (options.should_interrupt?.() === true) break;
      total_checked++;
      const intact =
        options.fast === true
          ? await ctx.storage.exists(ref.storage_key)
          : await blob_matches(ctx, ref);
      if (!intact) failed_storage_keys.push(ref.storage_key);
      emit_operation_progress(options, {
        operation: 'verify',
        workload: 'teams',
        phase: 'processing',
        processed: total_checked,
        total: refs.length,
      });
    }
    return { failed_storage_keys, total_checked };
  }
}
