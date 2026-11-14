import type { Command } from 'commander';
import type { Container } from 'inversify';
import { with_tenant } from '@/commands/shared/shared-options';
import { execute_rewrap, type RewrapOptions } from '@/commands/tenant/keys-rewrap.handlers';

type ContainerFactory = () => Container;

/**
 * Registers the `atlas keys` group.
 *
 * The group exists because a key operation is neither a workload nor configuration, and burying
 * `rewrap` under `config` would suggest it edits a setting rather than rewriting an object in the
 * bucket.
 */
export function register_keys_command(program: Command, get_container: ContainerFactory): void {
  const group = program.command('keys').description('Manage the tenant data keys');
  register_rewrap(group, get_container);
}

function register_rewrap(group: Command, get_container: ContainerFactory): void {
  const rewrap = group
    .command('rewrap')
    .description(
      'Re-wrap the data key of every tenant profile under a new passphrase or current KDF parameters',
    )
    .option(
      '--new-passphrase',
      'prompt for a new passphrase; omit to re-wrap under the configured one',
    )
    .option(
      '--old-passphrase',
      'prompt for the passphrase the keys are still wrapped under, when the configured one already changed',
    )
    .option(
      '--allow-partial',
      'with --tenant and --new-passphrase, re-wrap only that tenant and leave the others under the old passphrase',
    )
    .addHelpText(
      'after',
      [
        '',
        'The passphrase is shared by every tenant profile, so every profile is re-wrapped.',
        'The data key itself does not change: no stored object is re-encrypted and every',
        'snapshot stays readable. This rotates the wrapper, not the key.',
        '',
        'When every key is re-wrapped and the passphrase came from the encrypted config store,',
        'the new passphrase is stored there. Otherwise the command says where to change it.',
        'A partial run changes no configuration and exits 2; rerun it to finish.',
      ].join('\n'),
    );
  with_tenant(rewrap).action((options: RewrapOptions) => execute_rewrap(get_container(), options));
}
