import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { ObjectLockMode } from '@wisecom/atlas-types/ports/backup/use-case.port';
import type { StorageCheckResult, StorageCheckUseCase } from '@wisecom/atlas-types';
import { STORAGE_CHECK_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { Box } from 'ink';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import type { KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import { parse_lock_mode, parse_retention_days } from '@/command-object-lock';

type ContainerFactory = () => Container;

interface StorageCheckOptions {
  tenant?: string;
  lockMode?: string;
  retentionDays?: string;
}

/** Registers `atlas storage-check` for immutability readiness validation. */
export function register_storage_check_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  program
    .command('storage-check')
    .description('Check S3/MinIO Object Lock readiness for backup policies')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--lock-mode <mode>', 'Object Lock mode: governance|compliance')
    .option('--retention-days <n>', 'planned retention period in days')
    .action((options: StorageCheckOptions) => execute_storage_check(get_container(), options));
}

async function execute_storage_check(
  container: Container,
  options: StorageCheckOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const request = build_request(options);
  const use_case = container.get<StorageCheckUseCase>(STORAGE_CHECK_USE_CASE_TOKEN);
  const result = await use_case.check_storage(tenant_id, request);

  const ready =
    result.reachable &&
    result.versioning_enabled &&
    result.object_lock_enabled &&
    result.mode_supported;

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Storage Check" />
      <KeyValueList items={build_result_items(result, ready)} />
    </Box>,
  );

  if (!ready) process.exitCode = 1;
}

function build_result_items(result: StorageCheckResult, ready: boolean): KeyValueItem[] {
  const bucket_class = classify_bucket(result);
  const items: KeyValueItem[] = [
    { label: 'Bucket', value: result.bucket },
    { label: 'Reachable', value: result.reachable ? 'yes' : 'no' },
    { label: 'Versioning', value: result.versioning_enabled ? 'enabled' : 'disabled' },
    { label: 'Object Lock', value: result.object_lock_enabled ? 'enabled' : 'disabled' },
    { label: 'Bucket class', value: bucket_class.label, color: bucket_class.color },
    { label: 'Governance mode', value: result.mode_supported ? 'supported' : 'unsupported' },
    { label: 'Compliance mode', value: result.mode_supported ? 'supported' : 'unsupported' },
  ];
  if (result.requested_mode) {
    items.push({ label: 'Requested mode', value: result.requested_mode });
  }
  if (result.requested_retention_days) {
    items.push({ label: 'Requested retention', value: `${result.requested_retention_days} days` });
  }
  if (result.resolved_retain_until) {
    items.push({ label: 'Resolved retain-until', value: result.resolved_retain_until });
  }
  items.push({
    label: 'Status',
    value: ready ? 'ready' : 'not-ready',
    color: ready ? 'green' : 'red',
  });
  return items;
}

/**
 * Classifies the bucket for operators: lock-capable buckets can take
 * retention policies, versioned-only and unversioned ones are legacy
 * (pre-#30) and need the migration runbook in docs/self-hosting/storage.md.
 */
function classify_bucket(result: StorageCheckResult): { label: string; color: string } {
  if (result.object_lock_enabled) return { label: 'lock-capable', color: 'green' };
  if (result.versioning_enabled) return { label: 'versioned-only (legacy)', color: 'yellow' };
  return { label: 'unversioned (legacy)', color: 'red' };
}

function resolve_tenant_id(container: Container, options: StorageCheckOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

function build_request(options: StorageCheckOptions): {
  mode?: ObjectLockMode;
  retention_days?: number;
} {
  const mode = parse_lock_mode(options.lockMode);
  const retention_days = parse_retention_days(options.retentionDays);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(retention_days !== undefined ? { retention_days } : {}),
  };
}
