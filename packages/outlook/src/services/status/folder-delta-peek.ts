import type { FolderStatus, MailboxConnector, MailFolder } from '@wisecom/atlas-types';
import {
  describe_peek_error,
  rethrow_if_peek_fatal,
} from '@wisecom/atlas-core/services/shared/status-peek-error';
import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Messages per delta page during a status peek. Delta pages carry message bodies, so this stays
 * well below the backup page size while keeping a typical incremental to one or two requests.
 */
export const STATUS_PEEK_PAGE_SIZE = 50;

/**
 * Pages a status peek reads per folder before it stops and reports its count as a lower bound.
 * Counting exactly would mean downloading every pending message body, which is the backup's job;
 * 5 pages (up to 250 changes) answers "how much is waiting" for any routine incremental and caps
 * a folder whose delta was reset to a few requests.
 */
export const STATUS_PEEK_MAX_PAGES = 5;

/** Reads a folder's pending delta, up to the page cap, without saving the advanced link. */
export async function peek_folder_delta(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  folder: MailFolder,
  delta_link: string,
): Promise<FolderStatus> {
  let pending_new = 0;
  let stopped_at_cap = false;

  const result = await connector.fetch_delta(
    tenant_id,
    owner_id,
    folder.folder_id,
    delta_link,
    (page_num, _total, page_messages) => {
      pending_new += page_messages.length;
      stopped_at_cap = page_num >= STATUS_PEEK_MAX_PAGES;
      return !stopped_at_cap;
    },
    STATUS_PEEK_PAGE_SIZE,
  );

  const pending_removed = result.removed_ids.length;
  return {
    folder_id: folder.folder_id,
    folder_name: folder.folder_path,
    has_backup: true,
    pending_new,
    pending_removed,
    // Only the final page carries a delta link, so a cap that landed on it lost nothing.
    pending_capped: stopped_at_cap && result.delta_link === '',
    is_up_to_date: pending_new === 0 && pending_removed === 0,
  };
}

/**
 * Peeks one folder, rethrowing failures that apply to the whole mailbox and recording any other
 * failure on the folder's row so it reads as an error rather than as pending changes.
 */
export async function peek_folder_or_record_error(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  folder: MailFolder,
  delta_link: string,
): Promise<FolderStatus> {
  try {
    return await peek_folder_delta(connector, tenant_id, owner_id, folder, delta_link);
  } catch (err) {
    rethrow_if_peek_fatal(err);
    const peek_error = describe_peek_error(err);
    logger.warn(`Status peek failed for folder ${folder.folder_path}: ${peek_error}`);
    return {
      folder_id: folder.folder_id,
      folder_name: folder.folder_path,
      has_backup: true,
      pending_new: 0,
      pending_removed: 0,
      pending_capped: false,
      is_up_to_date: false,
      peek_error,
    };
  }
}
