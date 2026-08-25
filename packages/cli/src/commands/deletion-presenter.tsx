import type { DeletionResult } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { Banner } from '@/ui/components/banner';
import { ask_confirmation } from '@/ui/components/confirm-prompt';
import { render_static_view } from '@/ui/render';

/** Renders the shared delete banner every deletion command starts with. */
export async function render_delete_banner(): Promise<void> {
  await render_static_view(<Banner title="Atlas Delete" />);
}

/**
 * Warns what is about to be erased and asks for confirmation unless `skip_prompt` is set.
 * Returns false when the operator declines, so callers return without touching storage.
 */
export async function confirm_deletion(description: string, skip_prompt = false): Promise<boolean> {
  logger.warn(description);
  if (skip_prompt) return true;

  const confirmed = await ask_confirmation('Continue?', false);
  if (!confirmed) logger.info('Aborted');
  return confirmed;
}

/** Prints a summary of what was deleted, and fails the run on retained or failed objects. */
export function print_delete_result(result: DeletionResult): void {
  const no_deleted = result.deleted_objects === 0 && result.deleted_manifests === 0;
  const no_retained = result.retained_objects === 0 && result.retained_manifests === 0;
  const no_failed = result.failed_objects === 0 && result.failed_manifests === 0;

  if (no_deleted && no_retained && no_failed) {
    logger.warn('Nothing to delete');
    return;
  }

  logger.success(
    `Deleted ${result.deleted_objects} object(s), ${result.deleted_manifests} manifest(s)`,
  );
  logger.info(
    `Retained and not deleted: ${result.retained_objects} object(s), ` +
      `${result.retained_manifests} manifest(s)`,
  );
  logger.info(
    `Failed for other reasons: ${result.failed_objects} object(s), ` +
      `${result.failed_manifests} manifest(s)`,
  );

  if (!no_retained || !no_failed) {
    process.exitCode = 1;
  }
}
