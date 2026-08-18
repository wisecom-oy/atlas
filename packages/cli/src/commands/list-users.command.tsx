import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type { IdentityRegistryRepository, TenantContextFactory } from '@wisecom/atlas-types';
import {
  IDENTITY_REGISTRY_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { Box, Text } from 'ink';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import { DataTable } from '@/ui/components/data-table';
import type { TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';

type ContainerFactory = () => Container;

interface ListUsersOptions {
  tenant?: string;
}

interface UserRow {
  email: string;
  object_id: string;
  display_name: string;
}

interface RecycledUserRow extends UserRow {
  since: string;
}

const ACTIVE_COLUMNS: TableColumn<UserRow>[] = [
  { key: 'email', header: 'Email' },
  { key: 'object_id', header: 'Object ID' },
  { key: 'display_name', header: 'Display Name' },
];

const RECYCLED_COLUMNS: TableColumn<RecycledUserRow>[] = [
  { key: 'email', header: 'Email' },
  { key: 'object_id', header: 'Object ID' },
  { key: 'display_name', header: 'Display Name' },
  { key: 'since', header: 'Since' },
];

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

  const ctx = await ctx_factory.create_readonly(tenant_id);
  const registry = await registry_repo.load(ctx);

  if (!registry || registry.entries.length === 0) {
    await render_static_view(<Banner title="Atlas Identity Registry" />);
    logger.info('No users registered yet. Run a backup to populate the registry.');
    return;
  }

  const active = registry.entries.filter((e) => e.status === 'active');
  const recycled = registry.entries.filter((e) => e.status === 'recycled');

  const active_rows: UserRow[] = [...active]
    .sort((a, b) => a.email.localeCompare(b.email))
    .map((entry) => ({
      email: entry.email,
      object_id: entry.object_id,
      display_name: entry.display_name,
    }));

  const recycled_rows: RecycledUserRow[] = [...recycled]
    .sort((a, b) => a.email.localeCompare(b.email))
    .map((entry) => ({
      email: entry.email,
      object_id: entry.object_id,
      display_name: entry.display_name,
      since: entry.registered_at.slice(0, 10),
    }));

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Identity Registry" subtitle={`Tenant: ${registry.tenant_id}`} />
      <KeyValueList
        items={[
          { label: 'Active', value: String(active.length) },
          { label: 'Recycled', value: String(recycled.length) },
        ]}
      />
      <Box marginTop={1}>
        <DataTable columns={ACTIVE_COLUMNS} rows={active_rows} />
      </Box>
      {recycled_rows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Recycled (use object_id to access these backups):</Text>
          <DataTable columns={RECYCLED_COLUMNS} rows={recycled_rows} />
        </Box>
      ) : undefined}
    </Box>,
  );
}
