import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type {
  BackupUseCase,
  ObjectLockMode,
  ObjectLockPolicy,
  ObjectLockRequest,
  SyncOptions,
} from '@wisecom/atlas-types/ports/backup/use-case.port';
import type { TenantBackupOrchestrator } from '@wisecom/atlas-types';
import { BACKUP_USE_CASE_TOKEN, TENANT_ORCHESTRATOR_TOKEN } from '@wisecom/atlas-types';
import { run_backup_with_cli_adapter } from '@/adapters/backup-operation.adapter';
import { run_tenant_backup_with_cli_adapter } from '@/adapters/tenant-backup-operation.adapter';
import { format_bytes } from '@/command-formatters';
import { logger } from '@wisecom/atlas-core';

export interface OutlookBackupOptions {
  tenant?: string;
  mailbox?: string;
  folder?: string[];
  full?: boolean;
  pageSize?: string;
  retentionDays?: string;
  lockMode?: string;
  requireImmutability?: boolean;
  concurrency?: string;
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: OutlookBackupOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

/** Builds SyncOptions from CLI flags. */
function build_sync_options(options: OutlookBackupOptions): SyncOptions {
  const page_size = Math.max(1, Math.min(100, parseInt(options.pageSize ?? '10', 10) || 10));
  const object_lock_request = build_object_lock_request(options);
  const object_lock_policy = build_object_lock_policy(options);
  return {
    folder_filter: options.folder,
    force_full: options.full ?? false,
    page_size,
    object_lock_request,
    object_lock_policy,
  };
}

function build_object_lock_request(options: OutlookBackupOptions): ObjectLockRequest | undefined {
  const retention_days = parse_retention_days(options.retentionDays);
  const mode = parse_lock_mode(options.lockMode, retention_days ? 'GOVERNANCE' : undefined);
  if (!retention_days) {
    return undefined;
  }

  return {
    mode,
    retention_days,
  };
}

function build_object_lock_policy(options: OutlookBackupOptions): ObjectLockPolicy | undefined {
  const retention_days = parse_retention_days(options.retentionDays);
  const mode = parse_lock_mode(options.lockMode, retention_days ? 'GOVERNANCE' : undefined);
  const require_immutability = options.requireImmutability ?? true;
  if (!retention_days) {
    return undefined;
  }

  return {
    mode,
    require_immutability,
    retain_until: retention_days ? compute_retain_until_utc(retention_days) : undefined,
  };
}

function parse_lock_mode(
  raw_mode?: string,
  default_mode?: ObjectLockMode,
): ObjectLockMode | undefined {
  if (!raw_mode) return default_mode;
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

function compute_retain_until_utc(retention_days: number): string {
  const now = Date.now();
  const days_ms = retention_days * 24 * 60 * 60 * 1000;
  return new Date(now + days_ms).toISOString();
}

/** Dispatches a backup run for a single mailbox or the entire tenant. */
export async function execute_outlook_backup(
  container: Container,
  options: OutlookBackupOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Backup');
  logger.info(`Tenant:  ${tenant_id}`);

  if (options.folder) {
    logger.info(`Folders: ${options.folder.join(', ')}`);
  }

  if (options.mailbox) {
    await backup_single_mailbox(container, tenant_id, options.mailbox, build_sync_options(options));
  } else {
    await backup_all_mailboxes(container, tenant_id, options);
  }
}

/** Runs a single-mailbox backup and logs the outcome. */
async function backup_single_mailbox(
  container: Container,
  tenant_id: string,
  mailbox_id: string,
  sync_options: SyncOptions,
): Promise<void> {
  logger.info(`Mailbox: ${mailbox_id}`);
  const backup_use_case = container.get<BackupUseCase>(BACKUP_USE_CASE_TOKEN);
  const result = await run_backup_with_cli_adapter(
    backup_use_case,
    tenant_id,
    mailbox_id,
    sync_options,
  );
  logger.success(
    `Snapshot ${result.snapshot.id} -- ` +
      `${result.manifest.total_objects} objects, ` +
      format_bytes(result.manifest.total_size_bytes),
  );
}

/** Runs full-tenant backup via the orchestrator with CLI dashboard. */
async function backup_all_mailboxes(
  container: Container,
  tenant_id: string,
  options: OutlookBackupOptions,
): Promise<void> {
  const concurrency = Math.max(1, parseInt(options.concurrency ?? '4', 10) || 4);
  const page_size = Math.max(1, Math.min(100, parseInt(options.pageSize ?? '10', 10) || 10));

  logger.info(`Backing up all licensed mailboxes (concurrency=${concurrency})`);

  const orchestrator = container.get<TenantBackupOrchestrator>(TENANT_ORCHESTRATOR_TOKEN);
  await run_tenant_backup_with_cli_adapter(orchestrator, tenant_id, {
    concurrency,
    force_full: options.full ?? false,
    page_size,
  });
}
