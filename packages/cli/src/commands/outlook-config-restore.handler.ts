import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import { RESTORE_USE_CASE_TOKEN, type RestoreUseCase } from '@wisecom/atlas-types';
import { report_run_outcome, report_skipped_items } from '@/command-run-outcome';

/** Restores a snapshot's categories, mailbox settings, and inbox rules. */
export async function execute_outlook_config_restore(
  container: Container,
  options: { snapshot: string; tenant?: string; target?: string },
): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const service = container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN);
  const result = await service.restore_mailbox_config(tenant_id, options.snapshot, {
    ...(options.target ? { target_mailbox: options.target } : {}),
  });
  logger.info(
    `Restored ${result.categories_restored} categories, ` +
      `${result.settings_restored ? 'mailbox settings, ' : ''}${result.rules_restored} inbox rules`,
  );
  report_run_outcome(
    {
      errors: result.errors,
      warnings: result.skipped_rules.map((rule) => `Rule "${rule.name}" skipped: ${rule.reason}`),
      interrupted: false,
    },
    'mailbox configuration',
  );
  report_skipped_items(result.skipped_rules.length, 'inbox rule');
}
