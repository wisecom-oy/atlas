import type {
  OneDriveFileVersionIndex,
  OneDriveFileVersionRecord,
} from '../../domain/onedrive-manifest';
import type { TenantContext } from '../tenant/context.port';

export interface OneDriveFileVersionIndexRepository {
  /** Retrieves the version history for a specific file. */
  find_by_file_id(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
  ): Promise<OneDriveFileVersionIndex | undefined>;

  /** Appends a new version record to a file's history. */
  append_version(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
    version: OneDriveFileVersionRecord,
  ): Promise<OneDriveFileVersionIndex>;

  /** Lists all file version indexes for an owner. */
  list_by_owner(ctx: TenantContext, owner_id: string): Promise<OneDriveFileVersionIndex[]>;
}
