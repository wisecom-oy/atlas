import { Box } from 'ink';
import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { QuarantineUseCase } from '@wisecom/atlas-types';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import { banner_title, type BannerScope } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import { with_tenant } from '@/commands/shared/shared-options';

type ContainerFactory = () => Container;

/** The workload a `quarantine` subcommand belongs to, and where its use case is bound. */
export interface QuarantineCommandSpec {
  /** Command group name, e.g. `onedrive`. */
  readonly workload: Exclude<BannerScope, 'tenant'>;
  /** What the command accepts, for its description, e.g. `manifest or version index`. */
  readonly object_noun: string;
  readonly token: symbol;
}

interface QuarantineOptions {
  key: string;
  tenant?: string;
}

/** Registers `atlas <workload> quarantine --key <key>`. */
export function register_quarantine_command(
  group: Command,
  get_container: ContainerFactory,
  spec: QuarantineCommandSpec,
): void {
  const command = group
    .command('quarantine')
    .description(
      `Move an unreadable ${spec.object_noun} to _quarantine/ so later runs stop reporting it`,
    )
    .requiredOption('--key <storage-key>', 'storage key a command reported as unreadable');
  with_tenant(command).action((options: QuarantineOptions) =>
    execute_quarantine(get_container(), spec, options),
  );
}

/** Moves one unreadable object aside and prints where it went. */
export async function execute_quarantine(
  container: Container,
  spec: QuarantineCommandSpec,
  options: QuarantineOptions,
): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const quarantine = container.get<QuarantineUseCase>(spec.token);
  const result = await quarantine.quarantine_unreadable_object(tenant_id, options.key);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title(spec.workload, 'Quarantine')} />
      <KeyValueList
        items={[
          { label: 'Tenant', value: tenant_id },
          { label: 'Kind', value: result.kind },
          { label: 'Moved from', value: result.storage_key },
          { label: 'Moved to', value: result.quarantine_key },
          { label: 'Reason', value: result.reason },
        ]}
      />
    </Box>,
  );
  warn_what_was_lost(spec, result.kind);
}

/** Tells the operator what the moved object recorded that later commands no longer see. */
function warn_what_was_lost(spec: QuarantineCommandSpec, kind: string): void {
  if (kind === 'version_index') {
    logger.warn(
      'The versions this index recorded are no longer listed, and `restore-version --before` ' +
        'can now pick an older version of those files. Check `list-versions` before a rollback.',
    );
  } else if (spec.workload === 'contacts' || spec.workload === 'calendar') {
    logger.warn('The delta cursor was removed, so the next backup reads the mailbox in full.');
  } else if (spec.workload === 'teams') {
    logger.warn(
      'The next backup compares against the newest readable snapshot index, which is older. ' +
        'Channels whose cursor no longer matches that index are read in full.',
    );
  } else if (spec.workload === 'onedrive' || spec.workload === 'sharepoint') {
    // The cursor names the snapshot it was saved with, so a backup notices by itself when the
    // newest one is gone. An older one leaves a hole no cursor points at (issue #725).
    logger.warn(
      'If this was the newest snapshot, the next backup reads every drive in full by itself and ' +
        'captures the changes it recorded again. If newer snapshots exist, they no longer include ' +
        `those changes: run one \`atlas ${spec.workload} backup --full\` so the newest snapshot ` +
        'holds every current file.',
    );
  } else {
    logger.warn(
      'Snapshots taken after this one no longer include the changes it recorded. Run one ' +
        `\`atlas ${spec.workload} backup --full\` so the newest snapshot holds every current item.`,
    );
  }
}
