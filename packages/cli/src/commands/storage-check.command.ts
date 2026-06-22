import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN } from '@atlas/core';
import type { ObjectLockMode } from '@atlas/types/ports/backup/use-case.port';
import type { StorageCheckUseCase } from '@atlas/types';
import { STORAGE_CHECK_USE_CASE_TOKEN } from '@atlas/types';
import { logger } from '@atlas/core';

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
  logger.banner('Atlas Storage Check');
  logger.info(`Bucket: ${result.bucket}`);
  logger.info(`Reachable: ${result.reachable ? 'yes' : 'no'}`);
  logger.info(`Versioning: ${result.versioning_enabled ? 'enabled' : 'disabled'}`);
  logger.info(`Object Lock: ${result.object_lock_enabled ? 'enabled' : 'disabled'}`);
  logger.info(`Governance mode: ${result.mode_supported ? 'supported' : 'unsupported'}`);
  logger.info(`Compliance mode: ${result.mode_supported ? 'supported' : 'unsupported'}`);
  if (result.requested_mode) {
    logger.info(`Requested mode: ${result.requested_mode}`);
  }
  if (result.requested_retention_days) {
    logger.info(`Requested retention: ${result.requested_retention_days} days`);
  }
  if (result.resolved_retain_until) {
    logger.info(`Resolved retain-until: ${result.resolved_retain_until}`);
  }

  const ready =
    result.reachable &&
    result.versioning_enabled &&
    result.object_lock_enabled &&
    result.mode_supported;
  logger.info(`Status: ${ready ? 'ready' : 'not-ready'}`);
  if (!ready) process.exitCode = 1;
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

function parse_lock_mode(raw_mode?: string): ObjectLockMode | undefined {
  if (!raw_mode) return undefined;
  const normalized = raw_mode.trim().toUpperCase();
  if (normalized === 'GOVERNANCE') return 'GOVERNANCE';
  if (normalized === 'COMPLIANCE') return 'COMPLIANCE';
  throw new Error(
    `Invalid --lock-mode value "${raw_mode}". Expected "governance" or "compliance".`,
  );
}

function parse_retention_days(raw_days?: string): number | undefined {
  if (!raw_days) return undefined;
  const parsed = parseInt(raw_days, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --retention-days value "${raw_days}". Expected a positive integer.`);
  }
  return parsed;
}
