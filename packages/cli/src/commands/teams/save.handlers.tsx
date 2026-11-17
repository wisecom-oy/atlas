import type { Container } from 'inversify';
import { Box } from 'ink';
import { logger } from '@wisecom/atlas-core';
import type { TeamsSaveResult, TeamsSaveUseCase } from '@wisecom/atlas-types';
import { install_interrupt_gate } from '@/adapters/interrupt-gate';
import { confirm_output_overwrite } from '@/commands/shared/output-overwrite-guard';
import { TEAMS_SAVE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import { resolve_tenant_id } from '@/commands/sharepoint/command.handlers';
import type { TeamsTenantOptions } from '@/commands/teams/command.handlers';
import { save_exit_code } from '@/commands/teams/save-exit-code';

export interface TeamsSaveCommandOptions extends TeamsTenantOptions {
  team: string;
  snapshot: string;
  channel?: string;
  output?: string;
  yes?: boolean;
}

/** Saves one Teams snapshot, or one channel of it, as a browsable zip archive. */
export async function execute_teams_save(
  container: Container,
  options: TeamsSaveCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  if (!(await confirm_output_overwrite(options.output, options.yes))) return;
  const save = container.get<TeamsSaveUseCase>(TEAMS_SAVE_USE_CASE_TOKEN);
  const gate = install_interrupt_gate('Stopping the export after the current channel');
  let result: TeamsSaveResult;
  try {
    result = await save.save_snapshot(tenant_id, options.team, {
      snapshot_id: options.snapshot,
      ...(options.channel ? { channel_id: options.channel } : {}),
      ...(options.output ? { output_path: options.output } : {}),
      should_interrupt: gate.should_interrupt,
      abort_signal: gate.abort_signal,
    });
  } finally {
    gate.dispose();
  }

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('teams', 'Save')} />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Channels saved', value: String(result.channels_saved) },
          { label: 'Messages saved', value: String(result.messages_saved) },
          { label: 'Images inlined', value: String(result.images_inlined) },
          { label: 'Hosted files', value: String(result.hosted_files) },
          { label: 'Hosted content missing', value: String(result.hosted_missing.length) },
        ]}
      />
    </Box>,
  );
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} max={result.errors.length} />);
  }
  if (result.hosted_missing.length > 0) {
    logger.warn('Hosted content the backup never captured, so the archive lacks it:');
    await render_static_view(
      <ErrorList errors={result.hosted_missing} max={result.hosted_missing.length} />,
    );
  }
  const exit_code = save_exit_code(result);
  if (exit_code !== undefined) process.exitCode = exit_code;
  if (result.interrupted) {
    logger.warn(
      `Export interrupted. ${result.output_path} holds only the channels saved before it.`,
    );
  } else if (result.errors.length === 0) {
    const size_mb = (result.total_bytes / (1024 * 1024)).toFixed(1);
    logger.success(`Saved to ${result.output_path} (${size_mb} MB)`);
  }
}
