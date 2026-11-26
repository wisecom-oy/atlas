import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { SnapshotPruneUseCase } from '@wisecom/atlas-types';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import { confirm_deletion, render_delete_banner } from '@/commands/shared/deletion-presenter';
import { parse_prune_cutoff } from '@/commands/shared/prune-cutoff';
import { print_prune_result } from '@/commands/shared/prune-presenter';
import { with_tenant, with_yes } from '@/commands/shared/shared-options';

type ContainerFactory = () => Container;

/** The workload a `prune` subcommand belongs to, how it names its owner, and its use case. */
export interface PruneCommandSpec {
  readonly workload: 'outlook' | 'onedrive' | 'sharepoint';
  /** The owner flag as commander declares it, e.g. `-m, --mailbox <email|id>`. */
  readonly owner_flag: string;
  /** The options key commander stores that flag under, e.g. `mailbox`. */
  readonly owner_option: 'mailbox' | 'owner' | 'site';
  /** What the owner is called in messages, e.g. `mailbox`. */
  readonly owner_noun: string;
  readonly token: symbol;
  /** Resolves the flag's value to the id the storage keys use. */
  readonly resolve_owner: (
    container: Container,
    tenant_id: string,
    input: string,
  ) => Promise<string>;
}

interface PruneOptions {
  mailbox?: string;
  owner?: string;
  site?: string;
  before: string;
  dryRun?: boolean;
  yes?: boolean;
  tenant?: string;
}

/** Registers `atlas <workload> prune --before <cut-off>`. */
export function register_prune_command(
  group: Command,
  get_container: ContainerFactory,
  spec: PruneCommandSpec,
): void {
  const command = group
    .command('prune')
    .description(
      `Remove one ${spec.owner_noun}'s snapshots older than a cut-off and keep the newer ones restorable`,
    )
    .requiredOption(spec.owner_flag, `${spec.owner_noun} whose snapshots to prune`)
    .requiredOption(
      '--before <date|age>',
      'cut-off: an ISO 8601 date or date-time, or an age such as 90d, 12w or 36h',
    )
    .option('--dry-run', 'report what would be removed and change nothing');
  with_yes(command);
  with_tenant(command).action((options: PruneOptions) =>
    execute_prune(get_container(), spec, options),
  );
}

/** Prunes one owner after confirmation, or reports what a dry run would remove. */
export async function execute_prune(
  container: Container,
  spec: PruneCommandSpec,
  options: PruneOptions,
): Promise<void> {
  const before = parse_prune_cutoff(options.before, new Date());
  if (before === undefined) {
    logger.error(
      `--before must be an ISO 8601 date such as 2026-08-01, or an age such as 90d: ${options.before}`,
    );
    process.exitCode = 1;
    return;
  }
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  await render_delete_banner();
  const owner_input = options[spec.owner_option] ?? '';
  const owner_id = await spec.resolve_owner(container, tenant_id, owner_input);

  const dry_run = options.dryRun === true;
  if (!dry_run && !(await confirm_deletion(describe_prune(spec, owner_id, before), options.yes))) {
    return;
  }
  const prune = container.get<SnapshotPruneUseCase>(spec.token);
  const result = await prune.prune_snapshots(tenant_id, owner_id, { before, dry_run });
  print_prune_result(result);
}

function describe_prune(spec: PruneCommandSpec, owner_id: string, before: Date): string {
  return (
    `This will remove every ${spec.workload} snapshot of ${spec.owner_noun} ${owner_id} taken ` +
    `before ${before.toISOString()}, and the content no newer snapshot references. The newest ` +
    'snapshot is always kept.'
  );
}
