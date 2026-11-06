import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { config as load_dotenv } from 'dotenv';
import type { AtlasConfig, ConfigKeySpec, StoredConfig } from '@wisecom/atlas-core';
import {
  CONFIG_KEYS,
  find_config_key,
  logger,
  mask_secret,
  read_env_overrides,
  read_secure_config,
  secure_config_dir,
  try_load_config_file,
  write_secure_config,
} from '@wisecom/atlas-core';
import { probe_s3 } from '@/commands/tenant/config-probes';

type ConfigSources = {
  readonly file: StoredConfig;
  readonly secure: StoredConfig;
  readonly env: Partial<AtlasConfig>;
  readonly merged: Partial<AtlasConfig>;
};

const S3_FIELDS: (keyof AtlasConfig)[] = ['s3_endpoint', 's3_access_key', 's3_secret_key'];

/** Keys that moved to tenant profiles; kept here so the old spelling gets a pointer, not "unknown". */
const TENANT_CONFIG_KEYS = ['tenant.id', 'client.id', 'client.secret'];

/**
 * Registers the `atlas config` group.
 *
 * The verbs are subcommands rather than magic values smuggled into a positional argument, so
 * `atlas config list --help` documents itself the way every other command does (issue #162).
 */
export function register_config_command(program: Command): void {
  const group = program
    .command('config')
    .description('Get and set shared Atlas settings in the encrypted local store')
    .addHelpText(
      'after',
      [
        '',
        'Keys:',
        ...CONFIG_KEYS.map((k) => `  ${k.key.padEnd(24)} ${k.description}`),
        '',
        'Tenant credentials are per profile: manage them with "atlas tenants".',
      ].join('\n'),
    );
  // Inherited by every subcommand, so each verb sees ATLAS_* overrides from the environment.
  group.hook('preAction', () => {
    load_dotenv({ quiet: true });
  });

  group
    .command('list')
    .description('Print every shared key with its masked value and the source it resolves from')
    .action(() => execute_list());

  group
    .command('get')
    .description('Print the effective value of one key')
    .argument('<key>', 'config key (e.g. s3.region)')
    .action((key: string) => execute_get(require_config_key(key)));

  group
    .command('set')
    .description('Store a value in the encrypted local store')
    .argument('<key>', 'config key (e.g. s3.region)')
    .argument('<value>', 'value to set; "-" reads it from stdin')
    .action(async (key: string, value: string) => {
      // "-" reads the value from stdin so secrets never land in shell history.
      const resolved = value === '-' ? readFileSync(0, 'utf-8').trim() : value;
      await execute_set(require_config_key(key), resolved);
    });

  group
    .command('unset')
    .description('Remove a key from the encrypted local store')
    .argument('<key>', 'config key (e.g. s3.region)')
    .action((key: string) => execute_unset(key));

  group
    .command('validate')
    .description('Live-validate S3 connectivity with the effective config')
    .addHelpText('after', '\nTo validate tenant credentials, run "atlas tenants validate".')
    .action(async () => execute_validate());
}

/** Resolves a key spec, naming the discovery command when the key is unknown. */
function require_config_key(key: string): ConfigKeySpec {
  if (TENANT_CONFIG_KEYS.includes(key)) {
    throw new Error(
      'Tenant credentials now live in tenant profiles. Use ' +
        '"atlas tenants add <name> --tenant-id <id> --client-id <id> --client-secret -".',
    );
  }
  const spec = find_config_key(key);
  if (spec === undefined) {
    throw new Error(`Unknown config key "${key}". Run "atlas config list" to see all keys.`);
  }
  return spec;
}

/** Prints every shared key with its masked value and the source it resolves from. */
function execute_list(): void {
  const sources = read_sources();
  for (const spec of CONFIG_KEYS) {
    const value = sources.merged[spec.field];
    if (value === undefined) {
      logger.info(`${spec.key.padEnd(24)} <unset>`);
      continue;
    }
    const shown = spec.secret ? mask_secret(value) : value;
    logger.info(`${spec.key.padEnd(24)} ${shown}  (${resolve_source(sources, spec.field)})`);
  }
  logger.info(`Secure store: ${secure_config_dir()}/config.enc`);
}

/** Prints a single value (masked for secrets). */
function execute_get(spec: ConfigKeySpec): void {
  const sources = read_sources();
  const value = sources.merged[spec.field];
  if (value === undefined) {
    logger.warn(`${spec.key} is not set`);
    return;
  }
  console.log(spec.secret ? mask_secret(value) : value);
}

/** Validates, stores, and live-probes a config value. */
async function execute_set(spec: ConfigKeySpec, value: string): Promise<void> {
  const format_error = spec.validate(value);
  if (format_error !== null) {
    throw new Error(`Invalid value for ${spec.key}: ${format_error}`);
  }

  // Spread keeps tenants and active_tenant exactly as they are in the store.
  const stored = read_secure_config();
  write_secure_config({ ...stored, [spec.field]: value });
  logger.success(`Saved ${spec.key} to the encrypted store`);

  const sources = read_sources();
  if (sources.env[spec.field] !== undefined && sources.env[spec.field] !== value) {
    logger.warn(
      `An ATLAS_* environment variable currently overrides ${spec.key}; ` +
        'the stored value will not take effect until it is unset.',
    );
  }
  await probe_group_if_complete(spec.field, sources.merged);
}

/** Removes a key from the encrypted store. */
function execute_unset(key: string): void {
  const spec = require_config_key(key);

  const stored = read_secure_config();
  if (stored[spec.field] === undefined) {
    logger.warn(`${spec.key} is not set in the secure store`);
    return;
  }
  const rest = { ...stored };
  delete rest[spec.field];
  write_secure_config(rest);
  logger.success(`Removed ${spec.key} from the encrypted store`);
}

/** Live-validates S3 connectivity with the effective config. */
async function execute_validate(): Promise<void> {
  const { merged } = read_sources();
  if (!(await probe_s3(merged))) {
    process.exitCode = 1;
  }
}

/** Probes S3 once its fields are all set; region and passphrase changes wait for the next validate. */
async function probe_group_if_complete(
  field: keyof AtlasConfig,
  merged: Partial<AtlasConfig>,
): Promise<void> {
  if (S3_FIELDS.includes(field) || field === 's3_region') {
    if (S3_FIELDS.every((f) => merged[f] !== undefined)) {
      await probe_s3(merged);
    } else {
      logger.info('S3 settings incomplete -- skipping live validation for now.');
    }
  }
  // encryption.passphrase has no live probe: it is only verifiable against
  // an existing tenant DEK, which requires a tenant bucket round-trip.
}

/** Reads all three config sources plus their merge (env wins). */
function read_sources(): ConfigSources {
  const file = try_load_config_file();
  const secure = read_secure_config();
  const env = read_env_overrides();
  return { file, secure, env, merged: { ...file, ...secure, ...env } };
}

/** Names the highest-precedence source that provides a field. */
function resolve_source(sources: ConfigSources, field: keyof AtlasConfig): string {
  if (sources.env[field] !== undefined) return 'env';
  if (sources.secure[field] !== undefined) return 'secure store';
  return 'config file';
}
