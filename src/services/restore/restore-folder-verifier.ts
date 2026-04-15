import type { RestoreConnector } from '@/ports/restore/connector.port';
import { logger } from '@/utils/logger';

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
): Promise<void> {
  try {
    const remote_count = await restore_connector.count_folder_messages(
      tenant_id,
      mailbox_id,
      folder_id,
    );
    if (remote_count < attempted) {
      logger.warn(
        `Post-restore verification: folder "${folder_name}" has ${remote_count} messages ` +
          `but ${attempted} were attempted. ${attempted - remote_count} message(s) may not have persisted.`,
      );
    }
  } catch {
    logger.warn(
      `Post-restore verification failed for folder "${folder_name}" -- ` +
        `unable to confirm message count on tenant`,
    );
  }
}
