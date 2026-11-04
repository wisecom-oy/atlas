import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
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

/** Every blob a snapshot references: thread blobs and their hosted contents. */
function collect_blob_refs(manifest: TeamsSnapshotManifest): TeamsStoredBlobRef[] {
  return manifest.channels.flatMap((channel) =>
    Object.values(channel.threads).flatMap((thread) => [thread, ...Object.values(thread.hosted)]),
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

  /** Checks every blob a snapshot references against its recorded size and SHA-256 checksum. */
  async verify_teams_snapshot(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<TeamsVerificationResult> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, team_id, snapshot_id);
      if (manifest === undefined) {
        throw new NotFoundError(`Teams snapshot ${snapshot_id} not found for team ${team_id}`);
      }
      const failed_storage_keys: string[] = [];
      let total_checked = 0;
      let interrupted = false;
      for (const ref of collect_blob_refs(manifest)) {
        if (options.should_interrupt?.() === true) {
          interrupted = true;
          break;
        }
        total_checked++;
        if (!(await blob_matches(ctx, ref))) {
          failed_storage_keys.push(ref.storage_key);
        }
      }
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
}
