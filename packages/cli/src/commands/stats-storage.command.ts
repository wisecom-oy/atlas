import { Option } from 'commander';
import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { STORAGE_USAGE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import type { StorageUsageBreakdown, StorageUsageUseCase } from '@wisecom/atlas-types';
import { build_target } from '@/commands/replicate.command';
import { print_storage_usage } from '@/commands/stats-storage.view';

type ContainerFactory = () => Container;

/** Own flags plus the `-t`, `--top` and `--json` it shares with `atlas stats`. */
interface StorageUsageCommandOptions {
  tenant?: string;
  top?: string;
  json?: boolean;
  by: StorageUsageBreakdown;
  continue?: string;
  maxRequests?: string;
  targetEndpoint?: string;
  targetAccessKey?: string;
  targetSecretKey?: string;
  targetRegion?: string;
  targetConfig?: string;
}

/**
 * Registers `atlas stats storage`: physical bytes in the tenant bucket or a replica.
 *
 * `-t`, `--top` and `--json` are declared once, on `stats`. Commander hands an option the parent
 * knows to the parent wherever it appears, so a second declaration here would never receive a
 * value; the action reads them through `optsWithGlobals()` instead.
 */
export function register_stats_storage_command(
  stats: Command,
  get_container: ContainerFactory,
): void {
  stats
    .command('storage')
    .description(
      'Measure the bytes the tenant bucket physically holds, by listing it ' +
        '(also takes -t, --top and --json, shared with atlas stats)',
    )
    .addOption(
      new Option('--by <breakdown>', 'breakdown beyond the totals')
        .choices(['workload', 'owner'])
        .default('workload'),
    )
    .option('--target-endpoint <url>', 'measure a replica: target S3 endpoint URL')
    .option('--target-access-key <key>', 'replica S3 access key')
    .option('--target-secret-key <key>', 'replica S3 secret key; "-" reads it from stdin')
    .option('--target-region <region>', 'replica S3 region')
    .option('--target-config <path>', 'path to JSON file with replica S3 credentials')
    .option('--max-requests <n>', 'stop after this many S3 requests and print a continuation token')
    .option('--continue <token>', 'resume a measurement from its continuation token')
    .action((_options: unknown, command: Command) =>
      execute_storage_usage(get_container(), command.optsWithGlobals<StorageUsageCommandOptions>()),
    );
}

async function execute_storage_usage(
  container: Container,
  options: StorageUsageCommandOptions,
): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const wants_replica = Boolean(options.targetEndpoint || options.targetConfig);
  const usage = await container
    .get<StorageUsageUseCase>(STORAGE_USAGE_USE_CASE_TOKEN)
    .measure_storage_usage(tenant_id, {
      ...(wants_replica ? { target: build_target(container, options) } : {}),
      breakdown: options.by,
      continuation_token: options.continue,
      max_list_requests: parse_positive(options.maxRequests, '--max-requests'),
    });

  if (options.json) {
    console.log(JSON.stringify(usage, null, 2));
    return;
  }
  await print_storage_usage(usage, parse_positive(options.top, '--top') ?? 20);
}

function parse_positive(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}
