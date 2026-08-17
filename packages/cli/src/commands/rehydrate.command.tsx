import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type {
  ReplicationUseCase,
  SharePointReplicationUseCase,
  OneDriveReplicationUseCase,
} from '@wisecom/atlas-types';
import {
  REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { create_storage_target } from '@wisecom/atlas-s3';
import type { StorageTarget } from '@wisecom/atlas-types';
import type { ReplicationResult } from '@wisecom/atlas-types';
import { Box } from 'ink';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import type { KeyValueItem } from '@/ui/components/key-value-list';
import { ResultSummary } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';
import { format_bytes } from '@/command-formatters';
import { logger, GRAPH_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-core';
import type { UserIdentityResolver } from '@wisecom/atlas-types';

/**
 * Resolves an owner for recovery without touching primary storage.
 *
 * The shared `resolve_owner` helper persists the identity registry to primary, which would
 * bootstrap a fresh DEK there and make the source key un-copyable (`DekOverwriteRefusedError`).
 * Recovery therefore reads Graph directly, and passes a raw object ID through untouched so DR
 * still works when Graph is unreachable.
 */
async function resolve_owner_for_recovery(
  container: Container,
  tenant_id: string,
  owner_input: string,
): Promise<string> {
  if (!owner_input.includes('@')) return owner_input;
  const graph = container.get<UserIdentityResolver>(GRAPH_IDENTITY_RESOLVER_TOKEN);
  const identity = await graph.resolve_user(tenant_id, owner_input);
  logger.info(`Resolved ${owner_input} -> ${identity.object_id} (${identity.display_name})`);
  return identity.object_id;
}

type ContainerFactory = () => Container;

interface RehydrateOptions {
  snapshot?: string;
  mailbox?: string;
  site?: string;
  owner?: string;
  all?: boolean;
  tenant?: string;
  sourceEndpoint?: string;
  sourceAccessKey?: string;
  sourceSecretKey?: string;
  sourceRegion?: string;
  sourceConfig?: string;
}

/** Registers the `atlas rehydrate` subcommand for disaster recovery. */
export function register_rehydrate_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  program
    .command('rehydrate')
    .description('Recover snapshots from a replica to primary (disaster recovery)')
    .option('-s, --snapshot <id>', 'recover a specific snapshot')
    .option('-m, --mailbox <id>', 'recover all snapshots for a mailbox')
    .option('--site <url-or-id>', 'recover all snapshots for a SharePoint site')
    .option('-o, --owner <email-or-id>', 'recover all OneDrive snapshots for an owner')
    .option('--all', 'recover all mailboxes and snapshots (full tenant DR)')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--source-endpoint <url>', 'source replica S3 endpoint URL')
    .option('--source-access-key <key>', 'source replica S3 access key')
    .option('--source-secret-key <key>', 'source replica S3 secret key')
    .option('--source-region <region>', 'source replica S3 region')
    .option('--source-config <path>', 'path to JSON file with source S3 credentials')
    .action((options: RehydrateOptions) => execute_rehydrate(get_container(), options));
}

function resolve_tenant_id(container: Container, options: RehydrateOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

/** Describes the recovery mode implied by the given flags, if any. */
function resolve_mode_text(options: RehydrateOptions): string | undefined {
  if (options.site && options.snapshot) {
    return `recover SharePoint snapshot ${options.snapshot} for site ${options.site}`;
  }
  if (options.site) return `recover SharePoint site ${options.site}`;
  if (options.owner && options.snapshot) {
    return `recover OneDrive snapshot ${options.snapshot} for owner ${options.owner}`;
  }
  if (options.owner) return `recover OneDrive owner ${options.owner}`;
  if (options.snapshot) return `recover snapshot ${options.snapshot}`;
  if (options.mailbox) return `recover mailbox ${options.mailbox}`;
  if (options.all) return 'full tenant recovery';
  return undefined;
}

async function execute_rehydrate(container: Container, options: RehydrateOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const use_case = container.get<ReplicationUseCase>(REPLICATION_USE_CASE_TOKEN);
  const source = build_source(container, options);
  const mode_text = resolve_mode_text(options);

  const header_items: KeyValueItem[] = [
    { label: 'Tenant', value: tenant_id },
    { label: 'Source', value: `${source.endpoint} (${source.target_id})` },
  ];
  if (mode_text !== undefined) header_items.push({ label: 'Mode', value: mode_text });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Rehydrate" />
      <KeyValueList items={header_items} />
    </Box>,
  );

  let result: ReplicationResult;

  if (options.site) {
    const sharepoint_replication = container.get<SharePointReplicationUseCase>(
      SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
    );
    if (options.snapshot) {
      result = await sharepoint_replication.rehydrate_site_snapshot(
        tenant_id,
        options.site,
        options.snapshot,
        source,
      );
    } else {
      result = await sharepoint_replication.rehydrate_site(tenant_id, options.site, source);
    }
  } else if (options.owner) {
    const onedrive_replication = container.get<OneDriveReplicationUseCase>(
      ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
    );
    const owner_id = await resolve_owner_for_recovery(container, tenant_id, options.owner);
    if (options.snapshot) {
      result = await onedrive_replication.rehydrate_owner_snapshot(
        tenant_id,
        owner_id,
        options.snapshot,
        source,
      );
    } else {
      result = await onedrive_replication.rehydrate_owner(tenant_id, owner_id, source);
    }
  } else if (options.snapshot) {
    result = await use_case.rehydrate_snapshot(tenant_id, options.snapshot, source);
  } else if (options.mailbox) {
    result = await use_case.rehydrate_mailbox(tenant_id, options.mailbox, source);
  } else if (options.all) {
    result = await use_case.rehydrate_tenant(tenant_id, source);
  } else {
    logger.error('One of --snapshot, --mailbox, --owner, --site, or --all is required');
    process.exitCode = 1;
    return;
  }

  await report_result(result);
}

function build_source(container: Container, options: RehydrateOptions): StorageTarget {
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);

  if (options.sourceConfig) {
    const raw = readFileSync(options.sourceConfig, 'utf-8');
    const file = JSON.parse(raw) as Record<string, unknown>;
    const s3_endpoint = file.s3_endpoint;
    const s3_access_key = file.s3_access_key;
    const s3_secret_key = file.s3_secret_key;
    if (
      typeof s3_endpoint !== 'string' ||
      typeof s3_access_key !== 'string' ||
      typeof s3_secret_key !== 'string'
    ) {
      throw new Error(
        'source-config JSON must include string fields s3_endpoint, s3_access_key, s3_secret_key',
      );
    }
    const target_id = file.target_id;
    const s3_region = file.s3_region;
    return create_storage_target({
      ...(typeof target_id === 'string' ? { target_id } : {}),
      s3_endpoint,
      s3_access_key,
      s3_secret_key,
      ...(typeof s3_region === 'string' ? { s3_region } : {}),
      encryption_passphrase: config.encryption_passphrase,
    });
  }

  if (!options.sourceEndpoint || !options.sourceAccessKey || !options.sourceSecretKey) {
    throw new Error(
      'Source credentials required: provide --source-endpoint, --source-access-key, --source-secret-key ' +
        'or --source-config <path>',
    );
  }

  return create_storage_target({
    s3_endpoint: options.sourceEndpoint,
    s3_access_key: options.sourceAccessKey,
    s3_secret_key: options.sourceSecretKey,
    ...(options.sourceRegion !== undefined ? { s3_region: options.sourceRegion } : {}),
    encryption_passphrase: config.encryption_passphrase,
  });
}

async function report_result(result: ReplicationResult): Promise<void> {
  await render_static_view(
    <Box flexDirection="column">
      <KeyValueList
        items={[
          {
            label: 'Result',
            value: result.status,
            color: result.status === 'COMPLETED' ? 'green' : 'red',
          },
        ]}
      />
      <ResultSummary
        entries={[
          { label: 'copied', value: result.objects_copied, color: 'green' },
          { label: 'skipped', value: result.objects_skipped, color: 'yellow' },
          { label: 'failed', value: result.objects_failed, color: 'red' },
        ]}
        suffix={`${format_bytes(result.bytes_copied)}, ${result.elapsed_ms}ms`}
      />
    </Box>,
  );

  for (const err of result.errors) {
    logger.error(`  ${err}`);
  }

  if (result.objects_failed > 0) process.exitCode = 1;
}
