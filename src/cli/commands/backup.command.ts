import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type {
  BackupUseCase,
  ObjectLockMode,
  ObjectLockPolicy,
  ObjectLockRequest,
  SyncOptions,
} from '@/ports/backup/use-case.port';
import type { TenantBackupOrchestrator } from '@/ports/backup/orchestrator.port';
import { BACKUP_USE_CASE_TOKEN, TENANT_ORCHESTRATOR_TOKEN } from '@/ports/tokens/use-case.tokens';
import { run_backup_with_cli_adapter } from '@/cli/adapters/backup-operation.adapter';
import { run_tenant_backup_with_cli_adapter } from '@/cli/adapters/tenant-backup-operation.adapter';
import { format_bytes } from '@/cli/command-formatters';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface BackupOptions {
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

/** Registers the `atlas backup` subcommand. */
export function register_backup_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('backup')
    .description('Back up mailboxes from M365 tenant to object storage')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <id>', 'specific mailbox to back up (backs up all if omitted)')
    .option('-f, --folder <name...>', 'specific folder(s) to back up (e.g. -f Inbox "Sent Items")')
    .option('--full', 'force a full backup, ignoring saved delta state from prior runs')
    .option('-P, --page-size <n>', 'Graph API page size per delta request (1-100)', '10')
    .option('--retention-days <n>', 'apply object lock retention for N days')
    .option('--lock-mode <mode>', 'Object Lock mode: governance|compliance')
    .option('--require-immutability', 'fail when immutability cannot be enforced')
    .option('-C, --concurrency <n>', 'parallel mailbox count for tenant backup (default 4)', '4')
    .action((options: BackupOptions) => execute_backup(get_container(), options));
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: BackupOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

/** Builds SyncOptions from CLI flags. */
function build_sync_options(options: BackupOptions): SyncOptions {
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

function build_object_lock_request(options: BackupOptions): ObjectLockRequest | undefined {
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

function build_object_lock_policy(options: BackupOptions): ObjectLockPolicy | undefined {
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
async function execute_backup(container: Container, options: BackupOptions): Promise<void> {
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
  options: BackupOptions,
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
