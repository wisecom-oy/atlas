import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type { ReplicationUseCase } from '@/ports/replication/use-case.port';
import { REPLICATION_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { create_storage_target } from '@/adapters/storage-target.factory';
import type { StorageTarget } from '@/ports/replication/storage-target.port';
import type { ReplicationResult, ReplicationStatusRecord } from '@/domain/replication';
import { format_bytes } from '@/cli/command-formatters';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface ReplicateOptions {
  snapshot?: string;
  mailbox?: string;
  tenant?: string;
  targetEndpoint?: string;
  targetAccessKey?: string;
  targetSecretKey?: string;
  targetRegion?: string;
  targetConfig?: string;
  status?: boolean;
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
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--target-endpoint <url>', 'target S3 endpoint URL')
    .option('--target-access-key <key>', 'target S3 access key')
    .option('--target-secret-key <key>', 'target S3 secret key')
    .option('--target-region <region>', 'target S3 region')
    .option('--target-config <path>', 'path to JSON file with target S3 credentials')
    .option('--status', 'show replication status instead of replicating')
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
    await show_status(use_case, tenant_id, options);
    return;
  }

  const target = build_target(container, options);
  logger.banner('Atlas Replicate');
  logger.info(`Tenant:  ${tenant_id}`);
  logger.info(`Target:  ${target.endpoint} (${target.target_id})`);

  if (options.snapshot) {
    const results = await use_case.replicate_snapshot(tenant_id, options.snapshot, [target]);
    report_results(results);
  } else if (options.mailbox) {
    const results = await use_case.replicate_mailbox(tenant_id, options.mailbox, [target]);
    report_results(results);
  } else {
    logger.error('Either --snapshot or --mailbox is required (or --status to view status)');
    process.exitCode = 1;
  }
}

function build_target(container: Container, options: ReplicateOptions): StorageTarget {
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);

  if (options.targetConfig) {
    const raw = readFileSync(options.targetConfig, 'utf-8');
    const file = JSON.parse(raw) as Record<string, string>;
    return create_storage_target({
      target_id: file.target_id,
      s3_endpoint: file.s3_endpoint,
      s3_access_key: file.s3_access_key,
      s3_secret_key: file.s3_secret_key,
      s3_region: file.s3_region,
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
    s3_region: options.targetRegion,
    encryption_passphrase: config.encryption_passphrase,
  });
}

function report_results(results: ReplicationResult[]): void {
  for (const r of results) {
    const status_text = r.status === 'COMPLETED' ? chalk.green(r.status) : chalk.red(r.status);

    logger.info(
      `Snapshot ${chalk.cyan(r.snapshot_id)} → ${r.target_id}: ${status_text} ` +
        `(${r.objects_copied} copied, ${r.objects_skipped} skipped, ${r.objects_failed} failed, ` +
        `${format_bytes(r.bytes_copied)}, ${r.elapsed_ms}ms)`,
    );

    for (const err of r.errors) {
      logger.error(`  ${err}`);
    }
  }

  const any_failed = results.some((r) => r.objects_failed > 0);
  if (any_failed) process.exitCode = 1;
}

async function show_status(
  use_case: ReplicationUseCase,
  tenant_id: string,
  options: ReplicateOptions,
): Promise<void> {
  logger.banner('Replication Status');

  let records: ReplicationStatusRecord[];
  if (options.snapshot) {
    records = await use_case.get_replication_status(tenant_id, options.snapshot);
  } else if (options.mailbox) {
    records = await use_case.get_replication_status_by_mailbox(tenant_id, options.mailbox);
  } else {
    records = await use_case.get_replication_status(tenant_id);
  }

  if (records.length === 0) {
    logger.info('No replication records found.');
    return;
  }

  for (const r of records) {
    const status_text = r.status === 'COMPLETED' ? chalk.green(r.status) : chalk.yellow(r.status);

    logger.info(
      `${r.mailbox_id} / ${chalk.cyan(r.snapshot_id)} → ${r.target_id}: ${status_text} ` +
        `(${r.objects_copied}/${r.objects_total} objects, ${format_bytes(r.bytes_copied)})`,
    );
  }
}
