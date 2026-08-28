import type { Container } from 'inversify';
import type {
  OneDriveApi,
  OneDriveBackupUseCase,
  OneDriveVerificationUseCase,
  OneDriveCatalogUseCase,
  OneDriveRestoreUseCase,
  OneDriveSaveUseCase,
  OneDriveDeletionUseCase,
  OneDriveReplicationUseCase,
  OneDriveStatusUseCase,
  UserIdentityResolver,
  ResolvedUserIdentity,
  StatsUseCase,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  ONEDRIVE_DELETION_USE_CASE_TOKEN,
  ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_STATUS_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  STATS_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { adapt_operation_options, adapt_required_operation_options } from '@/operation-options';

/** Builds the OneDriveApi sub-namespace from the DI container. */
export function create_onedrive_api(tenant_id: string, container: Container): OneDriveApi {
  const backup = container.get<OneDriveBackupUseCase>(ONEDRIVE_BACKUP_USE_CASE_TOKEN);
  const verification = container.get<OneDriveVerificationUseCase>(
    ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  );
  const catalog = container.get<OneDriveCatalogUseCase>(ONEDRIVE_CATALOG_USE_CASE_TOKEN);
  const restore = container.get<OneDriveRestoreUseCase>(ONEDRIVE_RESTORE_USE_CASE_TOKEN);
  const save = container.get<OneDriveSaveUseCase>(ONEDRIVE_SAVE_USE_CASE_TOKEN);
  const deletion = container.get<OneDriveDeletionUseCase>(ONEDRIVE_DELETION_USE_CASE_TOKEN);
  const replication = container.get<OneDriveReplicationUseCase>(
    ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
  );
  const status = container.get<OneDriveStatusUseCase>(ONEDRIVE_STATUS_USE_CASE_TOKEN);
  const stats = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);

  const identity = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);

  /**
   * Mirrors the CLI: an owner containing `@` is an email and is resolved to an Entra object ID,
   * anything else already is one. Without this the same input addresses a non-existent owner and
   * the call returns an empty result instead of failing.
   */
  async function resolve_owner(owner: string): Promise<ResolvedUserIdentity | undefined> {
    if (!owner.includes('@')) return undefined;
    return await identity.resolve_user(tenant_id, owner);
  }

  async function resolve_owner_id(owner: string): Promise<string> {
    return (await resolve_owner(owner))?.object_id ?? owner;
  }

  return {
    async backup(owner_input, options) {
      const resolved = await resolve_owner(owner_input);
      const adapted = adapt_operation_options(options);
      // Forward the resolved identity so the registry learns the email, as the CLI does.
      return await backup.backup_onedrive(tenant_id, resolved?.object_id ?? owner_input, {
        ...adapted,
        ...(resolved && adapted?.owner_email === undefined
          ? { owner_email: resolved.email, owner_display_name: resolved.display_name }
          : {}),
      });
    },
    async verify(owner_input, snapshot_id, options) {
      const owner_id = await resolve_owner_id(owner_input);
      const adapted = adapt_operation_options(options);
      return adapted === undefined
        ? await verification.verify_onedrive_snapshot(tenant_id, owner_id, snapshot_id)
        : await verification.verify_onedrive_snapshot(tenant_id, owner_id, snapshot_id, adapted);
    },
    async restore(owner_input, options) {
      const owner_id = await resolve_owner_id(owner_input);
      return await restore.restore_onedrive(
        tenant_id,
        owner_id,
        adapt_required_operation_options(options, 'onedrive.restore()'),
      );
    },
    async save(owner_input, options) {
      const owner_id = await resolve_owner_id(owner_input);
      return await save.save_snapshot(
        tenant_id,
        owner_id,
        adapt_required_operation_options(options, 'onedrive.save()'),
      );
    },
    async listSnapshots(owner_input) {
      return await catalog.list_onedrive_snapshots(tenant_id, await resolve_owner_id(owner_input));
    },
    async listFileVersions(owner_input, file_ref) {
      const owner_id = await resolve_owner_id(owner_input);
      return await catalog.list_onedrive_file_versions(tenant_id, owner_id, file_ref);
    },
    async deleteOwnerData(owner_input) {
      return await deletion.delete_owner_data(tenant_id, await resolve_owner_id(owner_input));
    },
    async deleteSnapshot(owner_input, snapshot_id) {
      const owner_id = await resolve_owner_id(owner_input);
      return await deletion.delete_snapshot(tenant_id, owner_id, snapshot_id);
    },
    async replicateSnapshot(owner_input, snapshot_id, targets) {
      const owner_id = await resolve_owner_id(owner_input);
      return await replication.replicate_owner(tenant_id, owner_id, snapshot_id, targets);
    },
    async replicateAll(owner_input, targets) {
      const owner_id = await resolve_owner_id(owner_input);
      return await replication.replicate_all_owner_snapshots(tenant_id, owner_id, targets);
    },
    async rehydrateSnapshot(owner_input, snapshot_id, source) {
      const owner_id = await resolve_owner_id(owner_input);
      return await replication.rehydrate_owner_snapshot(tenant_id, owner_id, snapshot_id, source);
    },
    async rehydrateOwner(owner_input, source) {
      const owner_id = await resolve_owner_id(owner_input);
      return await replication.rehydrate_owner(tenant_id, owner_id, source);
    },
    async checkStatus(owner_input) {
      return await status.check_onedrive_status(tenant_id, await resolve_owner_id(owner_input));
    },
    async getStats(owner_input) {
      const owner_id = owner_input === undefined ? undefined : await resolve_owner_id(owner_input);
      return await stats.get_onedrive_stats(tenant_id, owner_id);
    },
  };
}
