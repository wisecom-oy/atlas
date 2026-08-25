import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type { DeletionUseCase } from '@wisecom/atlas-types';
import { DELETION_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { print_delete_result, render_delete_banner } from '@/commands/deletion-presenter';
import { ask_exact_match } from '@/ui/components/confirm-prompt';

type ContainerFactory = () => Container;

export interface TenantDeleteOptions {
  tenant?: string;
  purge?: boolean;
  yes?: boolean;
}

/**
 * Registers the tenant-wide `atlas delete`. The purge sweeps the whole bucket across every
 * workload, so it lives at the top level rather than under a workload group (issue #163).
 */
export function register_tenant_delete_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  program
    .command('delete')
    .description('Delete tenant-wide data across every workload')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--purge', 'delete ALL data in the tenant bucket, every workload (irreversible)')
    .option('-y, --yes', 'skip confirmation prompt')
    .action((options: TenantDeleteOptions) => execute_tenant_delete(get_container(), options));
}

/** Purges every object in the tenant bucket after confirmation. */
export async function execute_tenant_delete(
  container: Container,
  options: TenantDeleteOptions,
): Promise<void> {
  if (!options.purge) {
    logger.error('Specify --purge to delete all tenant data, or use a workload delete command');
    process.exitCode = 1;
    return;
  }

  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  await render_delete_banner();

  logger.warn(
    `This will delete ALL data for tenant ${tenant_id} across Outlook, OneDrive and ` +
      `SharePoint (data, manifests, encryption keys)`,
  );
  if (!(await confirm_purge_target(tenant_id, options.yes))) {
    logger.info('Aborted');
    return;
  }

  const deletion = container.get<DeletionUseCase>(DELETION_USE_CASE_TOKEN);
  print_delete_result(await deletion.purge_tenant(tenant_id));
}

/**
 * Confirms the purge by having the tenant ID typed back, rather than accepting a keypress.
 *
 * A purge deletes every workload's objects and then the encryption key, so the mistake worth
 * guarding is not "meant to type n" but "purged the wrong tenant" (issue #187). Typing the target
 * is the only confirmation that catches it. `-y` remains a full bypass for scheduled runs.
 */
async function confirm_purge_target(tenant_id: string, skip_prompt = false): Promise<boolean> {
  if (skip_prompt) return true;
  return await ask_exact_match('Type the tenant ID to confirm:', tenant_id);
}
