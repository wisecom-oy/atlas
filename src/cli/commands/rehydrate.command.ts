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
import type { ReplicationResult } from '@/domain/replication';
import { format_bytes } from '@/cli/command-formatters';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface RehydrateOptions {
  snapshot?: string;
  mailbox?: string;
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

async function execute_rehydrate(container: Container, options: RehydrateOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const use_case = container.get<ReplicationUseCase>(REPLICATION_USE_CASE_TOKEN);
  const source = build_source(container, options);

  logger.banner('Atlas Rehydrate');
  logger.info(`Tenant:  ${tenant_id}`);
  logger.info(`Source:  ${source.endpoint} (${source.target_id})`);

  let result: ReplicationResult;

  if (options.snapshot) {
    logger.info(`Mode:    recover snapshot ${chalk.cyan(options.snapshot)}`);
    result = await use_case.rehydrate_snapshot(tenant_id, options.snapshot, source);
  } else if (options.mailbox) {
    logger.info(`Mode:    recover mailbox ${chalk.cyan(options.mailbox)}`);
    result = await use_case.rehydrate_mailbox(tenant_id, options.mailbox, source);
  } else if (options.all) {
    logger.info(`Mode:    full tenant recovery`);
    result = await use_case.rehydrate_tenant(tenant_id, source);
  } else {
    logger.error('One of --snapshot, --mailbox, or --all is required');
    process.exitCode = 1;
    return;
  }

  report_result(result);
}

function build_source(container: Container, options: RehydrateOptions): StorageTarget {
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);

  if (options.sourceConfig) {
    const raw = readFileSync(options.sourceConfig, 'utf-8');
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
    s3_region: options.sourceRegion,
    encryption_passphrase: config.encryption_passphrase,
  });
}

function report_result(result: ReplicationResult): void {
  const status_text =
    result.status === 'COMPLETED' ? chalk.green(result.status) : chalk.red(result.status);

  logger.info(
    `Result: ${status_text} -- ` +
      `${result.objects_copied} copied, ${result.objects_skipped} skipped, ` +
      `${result.objects_failed} failed (${format_bytes(result.bytes_copied)}, ${result.elapsed_ms}ms)`,
  );

  for (const err of result.errors) {
    logger.error(`  ${err}`);
  }

  if (result.objects_failed > 0) process.exitCode = 1;
}
