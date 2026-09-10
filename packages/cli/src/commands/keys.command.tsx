import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type { DekRewrapUseCase } from '@wisecom/atlas-types';
import { DEK_REWRAP_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { with_tenant } from '@/commands/shared-options';
import { prompt_new_passphrase } from '@/utils/passphrase-prompt';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';

type ContainerFactory = () => Container;

interface RewrapOptions {
  tenant?: string;
  newPassphrase?: boolean;
}

/**
 * Registers the `atlas keys` group.
 *
 * One verb so far. The group exists because a key operation is neither a workload nor
 * configuration, and burying `rewrap` under `config` would suggest it edits a setting rather than
 * rewriting an object in the bucket.
 */
export function register_keys_command(program: Command, get_container: ContainerFactory): void {
  const group = program.command('keys').description('Manage the tenant data key');

  const rewrap = group
    .command('rewrap')
    .description('Re-wrap the stored data key under a new passphrase or current KDF parameters')
    .option(
      '--new-passphrase',
      'prompt for a new passphrase; omit to re-wrap under the configured one',
    )
    .addHelpText(
      'after',
      [
        '',
        'The data key itself does not change, so no stored object is re-encrypted and every',
        'existing snapshot stays readable. This rotates the wrapper, not the key: anyone who',
        'already holds the data key or the plaintext is unaffected.',
        '',
        'Set ATLAS_ENCRYPTION_PASSPHRASE to the new value after this succeeds.',
      ].join('\n'),
    );
  with_tenant(rewrap).action((options: RewrapOptions) => execute_rewrap(get_container(), options));
}

async function execute_rewrap(container: Container, options: RewrapOptions): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const use_case = container.get<DekRewrapUseCase>(DEK_REWRAP_USE_CASE_TOKEN);

  // Prompted before the run, so a mistyped confirmation costs nothing.
  const new_passphrase = options.newPassphrase === true ? await prompt_new_passphrase() : undefined;

  await render_static_view(<Banner title={banner_title('tenant', 'Key Re-wrap')} />);
  const result = await use_case.rewrap_tenant_dek(tenant_id, new_passphrase);

  await render_static_view(
    <KeyValueList
      items={[
        { label: 'Tenant', value: result.tenant_id },
        { label: 'Passphrase', value: result.passphrase_changed ? 'changed' : 'unchanged' },
        {
          label: 'KDF',
          value:
            result.previous_kdf_id === result.kdf_id
              ? `${result.kdf_id} (unchanged)`
              : `${result.previous_kdf_id} -> ${result.kdf_id}`,
        },
      ]}
    />,
  );

  logger.success('Data key re-wrapped. No stored object was re-encrypted.');
  if (result.passphrase_changed) {
    logger.warn(
      'Update ATLAS_ENCRYPTION_PASSPHRASE (or `atlas config set encryption.passphrase`) before ' +
        'the next run. Keep the previous passphrase until a read succeeds with the new one.',
    );
  }
}
