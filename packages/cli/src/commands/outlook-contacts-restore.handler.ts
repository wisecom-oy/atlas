import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { RESTORE_USE_CASE_TOKEN, type RestoreUseCase } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { install_interrupt_gate } from '@/adapters/interrupt-gate';
import { report_run_outcome } from '@/command-run-outcome';

/** Restores the contacts present in a snapshot's merged delta chain. */
export async function execute_outlook_contacts_restore(
  container: Container,
  options: { snapshot: string; tenant?: string; target?: string },
): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const service = container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN);
  const gate = install_interrupt_gate('[!] Stopping after the current contact write');
  let result;
  try {
    result = await service.restore_contacts(tenant_id, options.snapshot, {
      ...(options.target ? { target_mailbox: options.target } : {}),
      should_interrupt: gate.should_interrupt,
    });
  } finally {
    gate.dispose();
  }
  logger.info(`Restored ${result.restored_count} contacts`);
  report_run_outcome(
    { errors: result.errors, warnings: [], interrupted: result.interrupted },
    'contact',
  );
}
