import type { Container } from 'inversify';
import { Box } from 'ink';
import { report_unreadable_keys } from '@/command-unreadable-objects';
import { logger } from '@wisecom/atlas-core';
import type { SharePointSaveUseCase } from '@wisecom/atlas-types';
import { SHAREPOINT_SAVE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import { report_skipped_items, report_unmatched_file_filters } from '@/command-run-outcome';
import { confirm_output_overwrite } from '@/commands/shared/output-overwrite-guard';
import {
  resolve_tenant_id,
  type SharePointTenantOptions,
} from '@/commands/sharepoint/command.handlers';
import { resolve_site_id } from '@/commands/sharepoint/site-resolution';

export interface SharePointSaveCommandOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
  fileFilter?: string[];
  output?: string;
  skipVerify?: boolean;
  yes?: boolean;
}

/** Saves a SharePoint snapshot's files as a zip archive, asking first if `--output` exists. */
export async function execute_sharepoint_save(
  container: Container,
  options: SharePointSaveCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  if (!(await confirm_output_overwrite(options.output, options.yes))) return;
  const site_id = await resolve_site_id(container, tenant_id, options.site);

  const save_uc = container.get<SharePointSaveUseCase>(SHAREPOINT_SAVE_USE_CASE_TOKEN);
  const result = await save_uc.save_snapshot(tenant_id, site_id, {
    snapshot_id: options.snapshot,
    ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
    ...(options.output ? { output_path: options.output } : {}),
    ...(options.skipVerify ? { skip_integrity_check: true } : {}),
  });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('sharepoint', 'Save')} />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Files saved', value: String(result.files_saved) },
        ]}
      />
    </Box>,
  );
  report_skipped_items(result.files_skipped, 'File');
  report_unreadable_keys(result.unreadable_keys);
  report_unmatched_file_filters(result.unmatched_file_filters);
  if (result.integrity_failures.length > 0)
    logger.warn(`Integrity failures: ${result.integrity_failures.length}`);
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} max={result.errors.length} />);
    process.exitCode = 1;
  } else {
    const size_mb = (result.total_bytes / (1024 * 1024)).toFixed(1);
    logger.success(`Saved to ${result.output_path} (${size_mb} MB)`);
  }
}
