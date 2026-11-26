import { injectable } from 'inversify';
import type {
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  load_drive_cursor,
  save_drive_cursor,
  type DriveCursorLayout,
} from '@wisecom/atlas-drive/shared/drive-cursor-store';
import { SHAREPOINT_KEYS } from '@/services/shared/storage-keys';

const LAYOUT: DriveCursorLayout = {
  label: 'SharePoint delta cursor',
  keys: SHAREPOINT_KEYS,
  owner_field: 'site_id',
};

/**
 * Persists the delta sync cursor (delta links + change tracking state) in S3: one document while
 * it is small, a head plus content-named parts once it tracks many items (#920).
 */
@injectable()
export class S3SharePointDeltaCursorRepository implements SharePointDeltaCursorRepository {
  /** Loads the cursor; undefined only if none exists, throws if it is unreadable or another site's. */
  async load(ctx: TenantContext, site_id: string): Promise<SharePointDeltaCursor | undefined> {
    return load_drive_cursor<SharePointDeltaCursor>(ctx, LAYOUT, site_id);
  }

  /** Stores the cursor state, replacing the previous one, and reads back what it writes. */
  async save(ctx: TenantContext, cursor: SharePointDeltaCursor): Promise<void> {
    await save_drive_cursor(ctx, LAYOUT, cursor);
  }
}
