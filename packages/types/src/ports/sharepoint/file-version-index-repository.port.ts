import type {
  SharePointFileVersionIndex,
  SharePointFileVersionRecord,
} from '../../domain/sharepoint-manifest';
import type { TenantContext } from '../tenant/context.port';

export interface SharePointFileVersionIndexRepository {
  /** Retrieves the version history for a specific file. */
  find_by_file_id(
    ctx: TenantContext,
    site_id: string,
    file_id: string,
  ): Promise<SharePointFileVersionIndex | undefined>;

  /** Appends a new version record to a file's history. */
  append_version(
    ctx: TenantContext,
    site_id: string,
    file_id: string,
    version: SharePointFileVersionRecord,
  ): Promise<SharePointFileVersionIndex>;

  /** Lists all file version indexes for a site. */
  list_by_site(ctx: TenantContext, site_id: string): Promise<SharePointFileVersionIndex[]>;
}
