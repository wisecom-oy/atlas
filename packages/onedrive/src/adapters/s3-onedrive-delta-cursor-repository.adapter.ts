import { injectable } from 'inversify';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  load_drive_cursor,
  save_drive_cursor,
  type DriveCursorLayout,
} from '@wisecom/atlas-drive/shared/drive-cursor-store';
import { ONEDRIVE_KEYS } from '@/services/shared/storage-keys';

const LAYOUT: DriveCursorLayout = {
  label: 'OneDrive delta cursor',
  keys: ONEDRIVE_KEYS,
  owner_field: 'owner_id',
};

/**
 * Persists the delta sync cursor (delta links + change tracking state) in S3: one document while
 * it is small, a head plus content-named parts once it tracks many items (#920).
 */
@injectable()
export class S3OneDriveDeltaCursorRepository implements OneDriveDeltaCursorRepository {
  /** Loads the cursor; undefined only if none exists, throws if it is unreadable or another owner's. */
  async load(ctx: TenantContext, owner_id: string): Promise<OneDriveDeltaCursor | undefined> {
    return load_drive_cursor<OneDriveDeltaCursor>(ctx, LAYOUT, owner_id);
  }

  /** Stores the cursor state, replacing the previous one, and reads back what it writes. */
  async save(ctx: TenantContext, cursor: OneDriveDeltaCursor): Promise<void> {
    await save_drive_cursor(ctx, LAYOUT, cursor);
  }
}
