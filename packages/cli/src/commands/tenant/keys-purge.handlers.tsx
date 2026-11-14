import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type {
  OldWrapperPurgeUseCase,
  OldWrapperVersionOutcome,
  TenantWrapperPurgeOutcome,
} from '@wisecom/atlas-types';
import { OLD_WRAPPER_PURGE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import {
  list_tenants_sharing_passphrase,
  resolve_key_tenant_scope,
} from '@/commands/tenant/key-tenant-scope';
import { prompt_key_passphrases } from '@/utils/passphrase-prompt';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { ask_confirmation } from '@/ui/components/confirm-prompt';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';

/** Exit code when an old wrapper is still in some bucket. */
const EXIT_PARTIAL = 2;

export interface PurgeOldWrappersOptions {
  tenant?: string;
  oldPassphrase?: boolean;
  yes?: boolean;
}

interface PurgeRow {
  tenant: string;
  result: string;
  deleted: number;
  kept: number;
}

const COLUMNS: TableColumn<PurgeRow>[] = [
  { key: 'tenant', header: 'Tenant' },
  { key: 'result', header: 'Result' },
  { key: 'deleted', header: 'Deleted', align: 'right' },
  { key: 'kept', header: 'Kept', align: 'right' },
];

/** Deletes the noncurrent `_meta/dek.enc` versions a re-wrap left behind, after confirmation. */
export async function execute_purge_old_wrappers(
  container: Container,
  options: PurgeOldWrappersOptions,
): Promise<void> {
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  const scope = resolve_key_tenant_scope(
    list_tenants_sharing_passphrase(config.tenant_id),
    options.tenant,
  );
  const typed = await prompt_key_passphrases({ old: options.oldPassphrase === true, new: false });

  await render_static_view(<Banner title={banner_title('tenant', 'Purge Old Key Wrappers')} />);
  if (!(await confirm_purge(scope.tenant_ids, options.yes === true))) {
    logger.info('Aborted. Nothing was deleted.');
    return;
  }

  const use_case = container.get<OldWrapperPurgeUseCase>(OLD_WRAPPER_PURGE_USE_CASE_TOKEN);
  const report = await use_case.purge_old_wrappers({
    tenant_ids: scope.tenant_ids,
    previous_passphrases: typed.old === undefined ? [] : [typed.old],
  });

  await render_static_view(<DataTable columns={COLUMNS} rows={report.outcomes.map(to_row)} />);
  for (const outcome of report.outcomes) log_kept_versions(outcome);
  if (!report.complete) {
    logger.warn(
      'Some old wrappers are still in storage. Each one still opens with the passphrase it was ' +
        'wrapped under. See docs/security.md, "Old wrapper versions", for what to do instead.',
    );
    process.exitCode = EXIT_PARTIAL;
    return;
  }
  logger.success('No old wrapper is left in any covered bucket.');
}

/**
 * Asks before deleting. The old versions are the way back if the new passphrase is lost, so a
 * deliberate yes is required; `-y` skips the question for scripted runs, and is required when
 * the old passphrase arrives on piped stdin, which leaves no input for an answer.
 */
async function confirm_purge(
  tenant_ids: readonly string[],
  skip_prompt: boolean,
): Promise<boolean> {
  if (skip_prompt) return true;
  logger.warn(
    `This deletes the noncurrent versions of _meta/dek.enc for ${tenant_ids.join(', ')}. ` +
      'They are the only way back to the old passphrase. Run it only after the configured ' +
      'passphrase was switched and a backup or restore succeeded with it.',
  );
  return ask_confirmation('Delete the old wrappers?', false);
}

/** Lists each version the purge kept, with the reason. */
function log_kept_versions(outcome: TenantWrapperPurgeOutcome): void {
  if (outcome.status === 'current_unopenable') {
    logger.error(
      `  [${outcome.tenant_id}] the configured passphrase does not open the current wrapper, ` +
        'so nothing was deleted. Finish the re-wrap and switch the configured passphrase first.',
    );
  }
  if (outcome.detail !== undefined) logger.error(`  [${outcome.tenant_id}] ${outcome.detail}`);
  for (const version of outcome.versions) {
    if (version.status === 'deleted') continue;
    logger.error(`  [${outcome.tenant_id}] version ${version.version_id}: ${kept_reason(version)}`);
  }
}

const VERSION_TEXT: Record<OldWrapperVersionOutcome['status'], string> = {
  deleted: 'deleted',
  retained: 'kept, Object Lock or a bucket policy refused the delete',
  unverified: 'kept, no supplied passphrase opens it; rerun with --old-passphrase',
  different_key: 'kept, it holds a different data key',
  failed: 'kept, the read or delete failed',
};

function kept_reason(version: OldWrapperVersionOutcome): string {
  const reason = VERSION_TEXT[version.status];
  return version.detail === undefined ? reason : `${reason}: ${version.detail}`;
}

const RESULT_TEXT: Record<TenantWrapperPurgeOutcome['status'], string> = {
  purged: 'purged',
  versions_left: 'versions left',
  no_key: 'no key yet',
  current_unopenable: 'refused',
  busy: 'busy, skipped',
  failed: 'failed',
};

function to_row(outcome: TenantWrapperPurgeOutcome): PurgeRow {
  const deleted = outcome.versions.filter((v) => v.status === 'deleted').length;
  return {
    tenant: outcome.tenant_id,
    result: RESULT_TEXT[outcome.status],
    deleted,
    kept: outcome.versions.length - deleted,
  };
}
