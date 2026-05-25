import { inject, injectable } from 'inversify';
import type {
  TenantContextFactory,
  OneDriveConnector,
  OneDriveDrive,
  OneDriveManifestRepository,
  OneDriveDeltaCursorRepository,
  OneDriveStatusUseCase,
  OneDriveStatusResult,
  OneDriveDriveStatus,
} from '@atlas/types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN,
} from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

@injectable()
export class OneDriveStatusService implements OneDriveStatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: OneDriveDeltaCursorRepository,
  ) {}

  /** Peeks at Graph delta state to report whether a OneDrive backup is current. */
  async check_onedrive_status(tenant_id: string, owner_id: string): Promise<OneDriveStatusResult> {
    owner_id = owner_id.toLowerCase();

    const ctx = await this._tenant_factory.create(tenant_id);
    const saved_cursor = await this._cursors.load(ctx, owner_id);
    const saved_links = saved_cursor?.delta_link_by_drive ?? {};

    const all_drives = await this._connector.list_drives(tenant_id, owner_id);
    const previous = await this._manifests.find_latest_by_owner(ctx, owner_id);

    const drive_statuses = await this.peek_all_drives(tenant_id, owner_id, all_drives, saved_links);

    const total_pending = drive_statuses.reduce((sum, d) => sum + d.pending_changes, 0);

    return {
      owner_id,
      last_backup_at: previous?.created_at ? new Date(previous.created_at) : undefined,
      last_snapshot_id: previous?.snapshot_id,
      total_drives: all_drives.length,
      drives: drive_statuses,
      is_up_to_date: total_pending === 0 && drive_statuses.every((d) => d.has_backup),
      total_pending_changes: total_pending,
    };
  }

  private async peek_all_drives(
    tenant_id: string,
    owner_id: string,
    drives: OneDriveDrive[],
    saved_links: Record<string, string>,
  ): Promise<OneDriveDriveStatus[]> {
    const results: OneDriveDriveStatus[] = [];

    for (const drive of drives) {
      const delta_link = saved_links[drive.drive_id];
      if (!delta_link) {
        results.push({
          drive_id: drive.drive_id,
          drive_name: drive.drive_name,
          has_backup: false,
          pending_changes: 0,
          is_up_to_date: false,
        });
        continue;
      }

      try {
        const peek = await this.peek_drive_delta(tenant_id, owner_id, drive, delta_link);
        results.push(peek);
      } catch (err) {
        logger.debug(
          `Status peek failed for drive ${drive.drive_name}: ${err instanceof Error ? err.message : err}`,
        );
        results.push({
          drive_id: drive.drive_id,
          drive_name: drive.drive_name,
          has_backup: true,
          pending_changes: 0,
          is_up_to_date: false,
        });
      }
    }

    return results;
  }

  /** Fetches delta changes to count pending items without advancing persisted cursor state. */
  private async peek_drive_delta(
    tenant_id: string,
    owner_id: string,
    drive: OneDriveDrive,
    delta_link: string,
  ): Promise<OneDriveDriveStatus> {
    const result = await this._connector.fetch_delta(
      tenant_id,
      owner_id,
      drive.drive_id,
      delta_link,
    );

    const pending_changes = result.items.length;

    return {
      drive_id: drive.drive_id,
      drive_name: drive.drive_name,
      has_backup: true,
      pending_changes,
      is_up_to_date: pending_changes === 0,
    };
  }
}
