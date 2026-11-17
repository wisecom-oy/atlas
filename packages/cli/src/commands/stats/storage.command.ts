import { Option } from 'commander';
import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { STORAGE_USAGE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import type {
  StorageUsage,
  StorageUsageBreakdown,
  StorageUsageUseCase,
} from '@wisecom/atlas-types';
import { get_storage_usage_token } from '@wisecom/atlas-core/services/stats/storage-usage.service';
import { print_storage_usage } from '@/commands/stats/storage.view';

type ContainerFactory = () => Container;

/** Own flags plus the `-t`, `--top` and `--json` it shares with `atlas stats`. */
interface StorageUsageCommandOptions {
  tenant?: string;
  top?: string;
  json?: boolean;
  by: StorageUsageBreakdown;
  continue?: string;
  maxRequests?: string;
}

/**
 * Registers `atlas stats storage`: physical bytes in the tenant bucket on the configured endpoint.
 * A replica is measured by pointing the S3 endpoint at it.
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
  // Parsed before listing: a bad flag must not cost a full listing of the bucket first.
  const top = options.json ? 20 : (parse_positive(options.top, '--top') ?? 20);
  const max_list_requests = parse_positive(options.maxRequests, '--max-requests');

  let usage: StorageUsage;
  try {
    usage = await container
      .get<StorageUsageUseCase>(STORAGE_USAGE_USE_CASE_TOKEN)
      .measure_storage_usage(tenant_id, {
        breakdown: options.by,
        continuation_token: options.continue,
        max_list_requests,
      });
  } catch (err) {
    const token = get_storage_usage_token(err);
    if (token)
      console.error(`Measurement failed; resume with the same flags plus:\n--continue ${token}`);
    throw err;
  }

  if (options.json) {
    console.log(JSON.stringify(usage, null, 2));
    return;
  }
  await print_storage_usage(usage, top);
}

function parse_positive(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}
