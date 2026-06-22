import type { RestoreConnector } from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

/** Outcome of a post-restore folder message-count check. */
export interface FolderVerifyResult {
  readonly missing: number;
  readonly api_failed: boolean;
}

/**
 * Calls count_folder_messages after restoring a folder and warns if the
 * remote count is lower than the number of messages we attempted to create.
 */
export async function verify_folder_message_count(
  restore_connector: RestoreConnector,
  tenant_id: string,
  mailbox_id: string,
  folder_id: string,
  attempted: number,
  folder_name: string,
): Promise<FolderVerifyResult> {
  try {
    const remote_count = await restore_connector.count_folder_messages(
      tenant_id,
      mailbox_id,
      folder_id,
    );
    const missing = Math.max(attempted - remote_count, 0);
    if (missing > 0) {
      logger.warn(
        `Post-restore verification: folder "${folder_name}" has ${remote_count} messages ` +
          `but ${attempted} were attempted. ${missing} message(s) may not have persisted.`,
      );
    }
    return { missing, api_failed: false };
  } catch {
    logger.warn(
      `Post-restore verification failed for folder "${folder_name}" -- ` +
        `unable to confirm message count on tenant`,
    );
    return { missing: 0, api_failed: true };
  }
}
