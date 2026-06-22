import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN, logger } from '@atlas/core';
import type { IdentityRegistryRepository, TenantContextFactory } from '@atlas/types';
import { IDENTITY_REGISTRY_REPOSITORY_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@atlas/types';

type ContainerFactory = () => Container;

interface ListUsersOptions {
  tenant?: string;
}

/** Registers `atlas list-users` command to dump the local identity registry. */
export function register_list_users_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  program
    .command('list-users')
    .description('List all backed-up users from the local identity registry')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: ListUsersOptions) => execute_list_users(get_container(), options));
}

async function execute_list_users(container: Container, options: ListUsersOptions): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const ctx_factory = container.get<TenantContextFactory>(TENANT_CONTEXT_FACTORY_TOKEN);
  const registry_repo = container.get<IdentityRegistryRepository>(
    IDENTITY_REGISTRY_REPOSITORY_TOKEN,
  );

  const ctx = await ctx_factory.create(tenant_id);
  const registry = await registry_repo.load(ctx);

  logger.banner('Atlas Identity Registry');
  if (!registry || registry.entries.length === 0) {
    logger.info('No users registered yet. Run a backup to populate the registry.');
    return;
  }

  const active = registry.entries.filter((e) => e.status === 'active');
  const recycled = registry.entries.filter((e) => e.status === 'recycled');

  logger.info(`Tenant: ${registry.tenant_id}`);
  logger.info(`Active: ${active.length} | Recycled: ${recycled.length}\n`);

  const sorted_active = [...active].sort((a, b) => a.email.localeCompare(b.email));
  for (const entry of sorted_active) {
    logger.info(`  ${entry.email}  ${entry.object_id}  ${entry.display_name}`);
  }

  if (recycled.length > 0) {
    logger.info('');
    logger.info('Recycled (use object_id to access these backups):');
    const sorted_recycled = [...recycled].sort((a, b) => a.email.localeCompare(b.email));
    for (const entry of sorted_recycled) {
      logger.info(
        `  ${entry.email}  ${entry.object_id}  ${entry.display_name}  (since ${entry.registered_at.slice(0, 10)})`,
      );
    }
  }
}
