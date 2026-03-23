import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import type { Container } from 'inversify';
import chalk from 'chalk';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type { DeletionUseCase, DeletionResult } from '@/ports/deletion/use-case.port';
import { DELETION_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { logger } from '@/utils/logger';

type ContainerFactory = () => Container;

interface DeleteOptions {
  tenant?: string;
  mailbox?: string;
  snapshot?: string;
  purge?: boolean;
  yes?: boolean;
}

/** Registers the `atlas delete` subcommand. */
export function register_delete_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('delete')
    .description('Delete backed-up data (mailbox, snapshot, or entire tenant)')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <email>', 'delete all data and manifests for a mailbox')
    .option('-s, --snapshot <id>', 'delete a single snapshot manifest')
    .option('--purge', 'delete ALL data in the tenant bucket (irreversible)')
    .option('-y, --yes', 'skip confirmation prompt')
    .action((options: DeleteOptions) => execute_delete(get_container(), options));
}

/** Routes to the correct deletion scope and asks for confirmation. */
async function execute_delete(container: Container, options: DeleteOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Delete');

  const { scope, description } = determine_scope(options, tenant_id);
  if (!scope) {
    logger.error('Specify one of: --mailbox, --snapshot, or --purge');
    process.exitCode = 1;
    return;
  }

  logger.warn(description);

  if (!options.yes) {
    const confirmed = await ask_confirmation();
    if (!confirmed) {
      logger.info('Aborted');
      return;
    }
  }

  const deletion = container.get<DeletionUseCase>(DELETION_USE_CASE_TOKEN);
  const result = await dispatch_deletion(deletion, scope, tenant_id, options);
  print_result(result);
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

type DeleteScope = 'mailbox' | 'snapshot' | 'purge';

/** Determines which deletion path to take and builds a human-readable warning. */
function determine_scope(
  options: DeleteOptions,
  tenant_id: string,
): { scope: DeleteScope | undefined; description: string } {
  if (options.purge) {
    return {
      scope: 'purge',
      description: `This will delete ALL data for tenant ${tenant_id} (data, manifests, encryption keys)`,
    };
  }
  if (options.mailbox) {
    return {
      scope: 'mailbox',
      description: `This will delete all data and manifests for ${options.mailbox}`,
    };
  }
  if (options.snapshot) {
    return {
      scope: 'snapshot',
      description: `This will delete snapshot ${options.snapshot} (data objects are retained for other snapshots)`,
    };
  }
  return { scope: undefined, description: '' };
}

/** Dispatches to the correct DeletionService method. */
async function dispatch_deletion(
  deletion: DeletionUseCase,
  scope: DeleteScope,
  tenant_id: string,
  options: DeleteOptions,
): Promise<DeletionResult> {
  switch (scope) {
    case 'mailbox':
      return deletion.delete_mailbox_data(tenant_id, options.mailbox!);
    case 'snapshot':
      return deletion.delete_snapshot(tenant_id, options.snapshot!);
    case 'purge':
      return deletion.purge_tenant(tenant_id);
  }
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

/** Prompts "Continue? [y/N]" and returns true only on explicit "y". */
function ask_confirmation(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    rl.question(chalk.yellow('  Continue? [y/N] '), (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: DeleteOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

/** Prints a summary of what was deleted. */
function print_result(result: DeletionResult): void {
  const no_deleted = result.deleted_objects === 0 && result.deleted_manifests === 0;
  const no_retained = result.retained_objects === 0 && result.retained_manifests === 0;
  const no_failed = result.failed_objects === 0 && result.failed_manifests === 0;

  if (no_deleted && no_retained && no_failed) {
    logger.warn('Nothing to delete');
    return;
  }

  logger.success(
    `Deleted ${result.deleted_objects} object(s), ${result.deleted_manifests} manifest(s)`,
  );
  logger.info(
    `Retained and not deleted: ${result.retained_objects} object(s), ` +
      `${result.retained_manifests} manifest(s)`,
  );
  logger.info(
    `Failed for other reasons: ${result.failed_objects} object(s), ` +
      `${result.failed_manifests} manifest(s)`,
  );

  if (!no_retained || !no_failed) {
    process.exitCode = 1;
  }
}
