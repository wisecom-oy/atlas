import type { Command } from 'commander';
import { config as load_dotenv } from 'dotenv';
import { execute_add_profile } from '@/commands/tenant/tenant-profile-add';
import {
  execute_list_profiles,
  execute_remove_profile,
  execute_use_profile,
} from '@/commands/tenant/tenant-profile-manage';
import { execute_validate_profiles } from '@/commands/tenant/tenant-profile-validate';

/**
 * Registers the `atlas tenants` group: named Microsoft Graph credential profiles.
 * Each profile is one tenant. S3 settings and the encryption passphrase stay shared.
 */
export function register_tenants_command(program: Command): void {
  const group = program
    .command('tenants')
    .description('Manage named Microsoft Graph tenant profiles')
    .addHelpText(
      'after',
      '\nS3 settings and the encryption passphrase are shared across profiles; ' +
        'select one per run with --profile <name> or ATLAS_PROFILE.',
    );
  // Inherited by every subcommand so ATLAS_* variables from a .env file are visible.
  group.hook('preAction', () => {
    load_dotenv({ quiet: true });
  });

  group
    .command('add')
    .description('Add a tenant profile with its Graph credentials')
    .argument('<name>', 'profile name (lowercase letters, digits, dashes; max 32)')
    .requiredOption('--tenant-id <id>', 'Entra tenant ID (GUID or *.onmicrosoft.com domain)')
    .requiredOption('--client-id <id>', 'app registration client ID (GUID)')
    .requiredOption('--client-secret <value>', 'client secret; "-" reads it from stdin')
    .option('--replace', 'overwrite the credentials of an existing profile')
    .action(
      async (
        name: string,
        options: {
          tenantId: string;
          clientId: string;
          clientSecret: string;
          replace?: boolean;
        },
      ) => {
        await execute_add_profile(name, {
          tenantId: options.tenantId,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          ...(options.replace !== undefined ? { replace: options.replace } : {}),
        });
      },
    );

  group
    .command('list')
    .description('List tenant profiles with masked secrets and the selected one marked')
    .action((_options: unknown, command: Command) => {
      execute_list_profiles(selected_profile_flag(command));
    });

  group
    .command('use')
    .description('Make a tenant profile the stored active profile')
    .argument('<name>', 'profile name')
    .action((name: string) => execute_use_profile(name));

  group
    .command('remove')
    .description('Remove a tenant profile from the encrypted store')
    .argument('<name>', 'profile name')
    .option('-y, --yes', 'remove the active profile too')
    .action((name: string, options: { yes?: boolean }) => {
      execute_remove_profile(name, options);
    });

  group
    .command('validate')
    .description('Live-check Graph credentials for one profile, or all, and S3 once')
    .argument('[name]', 'profile name (default: the selected profile)')
    .option('--all', 'validate every profile')
    .action(async (name: string | undefined, options: { all?: boolean }, command: Command) => {
      await execute_validate_profiles(selected_profile_flag(command), name, options);
    });
}

/** The global `--profile` value, read from the root so it works before or after the subcommand. */
function selected_profile_flag(command: Command): string | undefined {
  return command.optsWithGlobals<{ profile?: string }>().profile;
}
