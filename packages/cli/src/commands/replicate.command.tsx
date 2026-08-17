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
import type { ReplicationResult, ReplicationStatusRecord } from '@wisecom/atlas-types';
import { Box } from 'ink';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import { DataTable } from '@/ui/components/data-table';
import type { TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';
import { format_bytes } from '@/command-formatters';
import { logger } from '@wisecom/atlas-core';
import { resolve_owner } from '@/commands/onedrive-command.handlers';
import { report_tenant_workloads } from '@/commands/tenant-workload-report';

type ContainerFactory = () => Container;

interface ReplicateOptions {
  snapshot?: string;
  mailbox?: string;
  site?: string;
  owner?: string;
  tenant?: string;
  targetEndpoint?: string;
  targetAccessKey?: string;
  targetSecretKey?: string;
  targetRegion?: string;
  targetConfig?: string;
  status?: boolean;
  all?: boolean;
}

/** Registers the `atlas replicate` subcommand. */
export function register_replicate_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  program
    .command('replicate')
    .description('Replicate snapshots to a secondary S3 storage target')
    .option('-s, --snapshot <id>', 'replicate a specific snapshot')
    .option('-m, --mailbox <id>', 'replicate all unreplicated snapshots for a mailbox')
    .option('--site <url-or-id>', 'replicate all unreplicated snapshots for a SharePoint site')
    .option(
      '-o, --owner <email-or-id>',
      'replicate all unreplicated snapshots for a OneDrive owner',
    )
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--target-endpoint <url>', 'target S3 endpoint URL')
    .option('--target-access-key <key>', 'target S3 access key')
    .option('--target-secret-key <key>', 'target S3 secret key')
    .option('--target-region <region>', 'target S3 region')
    .option('--target-config <path>', 'path to JSON file with target S3 credentials')
    .option('--status', 'show replication status instead of replicating')
    .option('--all', 'replicate every unreplicated snapshot of every workload')
    .action((options: ReplicateOptions) => execute_replicate(get_container(), options));
}

function resolve_tenant_id(container: Container, options: ReplicateOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

async function execute_replicate(container: Container, options: ReplicateOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const use_case = container.get<ReplicationUseCase>(REPLICATION_USE_CASE_TOKEN);

  if (options.status) {
    const owner_scope = options.owner
      ? (await resolve_owner(container, tenant_id, options.owner)).object_id
      : undefined;
    const scope_id = options.mailbox ?? options.site ?? owner_scope;
    await show_status(use_case, tenant_id, options.snapshot, scope_id);
    return;
  }

  const target = build_target(container, options);
  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Replicate" />
      <KeyValueList
        items={[
          { label: 'Tenant', value: tenant_id },
          { label: 'Target', value: `${target.endpoint} (${target.target_id})` },
        ]}
      />
    </Box>,
  );

  if (options.site) {
    const sharepoint_replication = container.get<SharePointReplicationUseCase>(
      SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
    );
    if (options.snapshot) {
      const results = await sharepoint_replication.replicate_site(
        tenant_id,
        options.site,
        options.snapshot,
        [target],
      );
      await report_results(results);
    } else {
      const results = await sharepoint_replication.replicate_all_site_snapshots(
        tenant_id,
        options.site,
        [target],
      );
      await report_results(results);
    }
  } else if (options.owner) {
    const onedrive_replication = container.get<OneDriveReplicationUseCase>(
      ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
    );
    const owner = await resolve_owner(container, tenant_id, options.owner);
    if (options.snapshot) {
      const results = await onedrive_replication.replicate_owner(
        tenant_id,
        owner.object_id,
        options.snapshot,
        [target],
      );
      await report_results(results);
    } else {
      const results = await onedrive_replication.replicate_all_owner_snapshots(
        tenant_id,
        owner.object_id,
        [target],
      );
      await report_results(results);
    }
  } else if (options.snapshot) {
    const results = await use_case.replicate_snapshot(tenant_id, options.snapshot, [target]);
    await report_results(results);
  } else if (options.mailbox) {
    const results = await use_case.replicate_mailbox(tenant_id, options.mailbox, [target]);
    await report_results(results);
  } else if (options.all) {
    await report_tenant_workloads(await use_case.replicate_tenant(tenant_id, [target]));
  } else {
    logger.error(
      'Either --snapshot, --mailbox, --owner, --site, or --all is required ' +
        '(or --status to view status)',
    );
    process.exitCode = 1;
  }
}

function build_target(container: Container, options: ReplicateOptions): StorageTarget {
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);

  if (options.targetConfig) {
    const raw = readFileSync(options.targetConfig, 'utf-8');
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
        'target-config JSON must include string fields s3_endpoint, s3_access_key, s3_secret_key',
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

  if (!options.targetEndpoint || !options.targetAccessKey || !options.targetSecretKey) {
    throw new Error(
      'Target credentials required: provide --target-endpoint, --target-access-key, --target-secret-key ' +
        'or --target-config <path>',
    );
  }

  return create_storage_target({
    s3_endpoint: options.targetEndpoint,
    s3_access_key: options.targetAccessKey,
    s3_secret_key: options.targetSecretKey,
    ...(options.targetRegion !== undefined ? { s3_region: options.targetRegion } : {}),
    encryption_passphrase: config.encryption_passphrase,
  });
}

interface ReplicationRow {
  snapshot: string;
  target: string;
  status: string;
  copied: number;
  skipped: number;
  failed: number;
  size: string;
  elapsed: string;
}

const RESULT_COLUMNS: TableColumn<ReplicationRow>[] = [
  { key: 'snapshot', header: 'Snapshot', color: () => 'cyan' },
  { key: 'target', header: 'Target' },
  {
    key: 'status',
    header: 'Status',
    color: (row) => (row.status === 'COMPLETED' ? 'green' : 'red'),
  },
  { key: 'copied', header: 'Copied' },
  { key: 'skipped', header: 'Skipped' },
  { key: 'failed', header: 'Failed' },
  { key: 'size', header: 'Size' },
  { key: 'elapsed', header: 'Elapsed' },
];

async function report_results(results: ReplicationResult[]): Promise<void> {
  const rows: ReplicationRow[] = results.map((r) => ({
    snapshot: r.snapshot_id,
    target: r.target_id,
    status: r.status,
    copied: r.objects_copied,
    skipped: r.objects_skipped,
    failed: r.objects_failed,
    size: format_bytes(r.bytes_copied),
    elapsed: `${r.elapsed_ms}ms`,
  }));
  await render_static_view(<DataTable columns={RESULT_COLUMNS} rows={rows} />);

  for (const r of results) {
    for (const err of r.errors) {
      logger.error(`  [${r.snapshot_id}] ${err}`);
    }
  }

  const any_failed = results.some((r) => r.objects_failed > 0);
  if (any_failed) process.exitCode = 1;
}

interface StatusRow {
  owner: string;
  snapshot: string;
  target: string;
  status: string;
  objects: string;
  size: string;
}

const STATUS_COLUMNS: TableColumn<StatusRow>[] = [
  { key: 'owner', header: 'Owner' },
  { key: 'snapshot', header: 'Snapshot', color: () => 'cyan' },
  { key: 'target', header: 'Target' },
  {
    key: 'status',
    header: 'Status',
    color: (row) => (row.status === 'COMPLETED' ? 'green' : 'yellow'),
  },
  { key: 'objects', header: 'Objects' },
  { key: 'size', header: 'Size' },
];

async function show_status(
  use_case: ReplicationUseCase,
  tenant_id: string,
  snapshot_id: string | undefined,
  scope_id: string | undefined,
): Promise<void> {
  await render_static_view(<Banner title="Replication Status" />);

  let records: ReplicationStatusRecord[];
  if (snapshot_id) {
    records = await use_case.get_replication_status(tenant_id, snapshot_id);
  } else if (scope_id) {
    records = await use_case.get_replication_status_by_owner(tenant_id, scope_id);
  } else {
    records = await use_case.get_replication_status(tenant_id);
  }

  if (records.length === 0) {
    logger.info('No replication records found.');
    return;
  }

  const rows: StatusRow[] = records.map((r) => ({
    owner: r.owner_id,
    snapshot: r.snapshot_id,
    target: r.target_id,
    status: r.status,
    objects: `${r.objects_copied}/${r.objects_total}`,
    size: format_bytes(r.bytes_copied),
  }));
  await render_static_view(<DataTable columns={STATUS_COLUMNS} rows={rows} />);
}
