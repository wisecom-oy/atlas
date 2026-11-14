import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type {
  TenantRewrapOutcome,
  TenantSetRewrapReport,
  TenantSetRewrapUseCase,
} from '@wisecom/atlas-types';
import { TENANT_SET_REWRAP_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import {
  assert_passphrase_change_covers_all,
  list_tenants_sharing_passphrase,
  resolve_key_tenant_scope,
} from '@/commands/tenant/key-tenant-scope';
import {
  describe_manual_passphrase_change,
  detect_passphrase_source,
  store_new_passphrase,
} from '@/commands/tenant/passphrase-source';
import { prompt_key_passphrases } from '@/utils/passphrase-prompt';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';

/** Exit code for a re-wrap that left some tenant under the old passphrase. */
const EXIT_PARTIAL = 2;

export interface RewrapOptions {
  tenant?: string;
  newPassphrase?: boolean;
  oldPassphrase?: boolean;
  allowPartial?: boolean;
}

interface RewrapRow {
  tenant: string;
  result: string;
  kdf: string;
}

const COLUMNS: TableColumn<RewrapRow>[] = [
  { key: 'tenant', header: 'Tenant' },
  { key: 'result', header: 'Result' },
  { key: 'kdf', header: 'KDF' },
];

/**
 * Re-wraps every tenant key that shares the passphrase, then retires the old passphrase only
 * when nothing is left under it (issue #716).
 */
export async function execute_rewrap(container: Container, options: RewrapOptions): Promise<void> {
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  const scope = resolve_key_tenant_scope(
    list_tenants_sharing_passphrase(config.tenant_id),
    options.tenant,
  );
  if (options.newPassphrase === true) {
    assert_passphrase_change_covers_all(scope, options.allowPartial === true);
  }

  // Prompted before the run, so a mistyped confirmation costs nothing.
  const typed = await prompt_key_passphrases({
    old: options.oldPassphrase === true,
    new: options.newPassphrase === true,
  });
  const next_passphrase = typed.new ?? config.encryption_passphrase;

  await render_static_view(<Banner title={banner_title('tenant', 'Key Re-wrap')} />);
  const use_case = container.get<TenantSetRewrapUseCase>(TENANT_SET_REWRAP_USE_CASE_TOKEN);
  const report = await use_case.rewrap_tenant_set({
    tenant_ids: scope.tenant_ids,
    current_passphrase: typed.old ?? config.encryption_passphrase,
    next_passphrase,
  });

  await render_static_view(<DataTable columns={COLUMNS} rows={report.outcomes.map(to_row)} />);
  log_failure_details(report.outcomes);
  // Tenants left out by `--tenant` only matter when a passphrase is being retired: a KDF refresh
  // of one tenant leaves the others exactly as usable as before. Retiring covers both the pair
  // this run re-wrapped between and the configured value it would overwrite: typing the same
  // value twice still replaces a configured passphrase the left-out tenants are wrapped under.
  const retires_passphrase =
    report.passphrase_changed || next_passphrase !== config.encryption_passphrase;
  const left_behind = retires_passphrase ? scope.left_out : [];
  const finished = report.complete && left_behind.length === 0;
  if (!finished) {
    report_partial_rewrap(report, left_behind, retires_passphrase);
    process.exitCode = EXIT_PARTIAL;
    return;
  }
  logger.success('Every data key is re-wrapped. No stored object was re-encrypted.');
  if (next_passphrase !== config.encryption_passphrase)
    switch_configured_passphrase(next_passphrase);
}

/** Puts the new passphrase where the configuration reads it, or says where to put it. */
function switch_configured_passphrase(new_passphrase: string): void {
  const source = detect_passphrase_source();
  if (source.kind !== 'secure_store') {
    logger.warn(describe_manual_passphrase_change(source));
    return;
  }
  store_new_passphrase(new_passphrase);
  logger.success('Stored the new passphrase in the encrypted config store.');
}

/** Names every tenant the run did not settle and what to run next. */
function report_partial_rewrap(
  report: TenantSetRewrapReport,
  left_behind: readonly string[],
  retires_passphrase: boolean,
): void {
  const unsettled = report.outcomes
    .filter((o) => o.status === 'unopenable' || o.status === 'busy' || o.status === 'failed')
    .map((o) => o.tenant_id);
  const remaining = [...unsettled, ...left_behind].join(', ');
  if (!retires_passphrase) {
    logger.warn(`Not finished: ${remaining} kept the wrapper they had. Run the command again.`);
    return;
  }
  logger.warn(
    `Not finished. Still under the old passphrase, or not confirmed otherwise: ${remaining}. ` +
      `The configuration was not changed. Keep the old passphrase, fix what the table reports, ` +
      `and run the same command again: tenants already re-wrapped are recognised and skipped.`,
  );
}

/** Prints the reason behind every busy or failed tenant. */
function log_failure_details(outcomes: readonly TenantRewrapOutcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.status === 'busy' || outcome.status === 'failed') {
      logger.error(`  [${outcome.tenant_id}] ${outcome.detail}`);
    }
    if (outcome.status === 'unopenable') {
      logger.error(
        `  [${outcome.tenant_id}] neither passphrase opens its key. If the configured value ` +
          `already changed, rerun with --old-passphrase.`,
      );
    }
  }
}

const RESULT_TEXT: Record<TenantRewrapOutcome['status'], string> = {
  rewrapped: 're-wrapped',
  already_rewrapped: 'already re-wrapped',
  no_key: 'no key yet',
  unopenable: 'neither passphrase opens it',
  busy: 'busy, skipped',
  failed: 'failed',
};

function to_row(outcome: TenantRewrapOutcome): RewrapRow {
  const kdf =
    outcome.status !== 'rewrapped'
      ? ''
      : outcome.previous_kdf_id === outcome.kdf_id
        ? `${outcome.kdf_id} (unchanged)`
        : `${outcome.previous_kdf_id} -> ${outcome.kdf_id}`;
  return { tenant: outcome.tenant_id, result: RESULT_TEXT[outcome.status], kdf };
}
