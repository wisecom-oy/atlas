import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { ClientSecretCredential } from '@azure/identity';
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { config as load_dotenv } from 'dotenv';
import type { AtlasConfig, ConfigKeySpec } from '@wisecom/atlas-core';
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
import { create_s3_client } from '@wisecom/atlas-s3';

type ConfigSources = {
  readonly file: Partial<AtlasConfig>;
  readonly secure: Partial<AtlasConfig>;
  readonly env: Partial<AtlasConfig>;
  readonly merged: Partial<AtlasConfig>;
};

const GRAPH_FIELDS: (keyof AtlasConfig)[] = ['tenant_id', 'client_id', 'client_secret'];
const S3_FIELDS: (keyof AtlasConfig)[] = ['s3_endpoint', 's3_access_key', 's3_secret_key'];

/** Registers the "atlas config" command (git-config style key/value store). */
export function register_config_command(program: Command): void {
  program
    .command('config')
    .description('Get and set Atlas configuration in the encrypted local store')
    .argument('[key]', 'config key (e.g. tenant.id), or: list | unset | validate')
    .argument('[value]', 'value to set; "-" reads from stdin; omit to print the current value')
    .addHelpText(
      'after',
      ['', 'Keys:', ...CONFIG_KEYS.map((k) => `  ${k.key.padEnd(24)} ${k.description}`)].join('\n'),
    )
    .action(async (key: string | undefined, value: string | undefined) => {
      load_dotenv();
      if (key === undefined || key === 'list') return execute_list();
      if (key === 'validate') return execute_validate();
      if (key === 'unset') return execute_unset(value);

      const spec = find_config_key(key);
      if (spec === undefined) {
        throw new Error(`Unknown config key "${key}". Run "atlas config list" to see all keys.`);
      }
      if (value === undefined) return execute_get(spec);
      // "-" reads the value from stdin so secrets never land in shell history.
      return execute_set(spec, value === '-' ? readFileSync(0, 'utf-8').trim() : value);
    });
}

/** Prints every key with its masked value and the source it resolves from. */
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
function execute_unset(key: string | undefined): void {
  if (key === undefined) throw new Error('Usage: atlas config unset <key>');
  const spec = find_config_key(key);
  if (spec === undefined) throw new Error(`Unknown config key "${key}"`);

  const stored = read_secure_config();
  if (stored[spec.field] === undefined) {
    logger.warn(`${spec.key} is not set in the secure store`);
    return;
  }
  const { [spec.field]: _removed, ...rest } = stored;
  write_secure_config(rest);
  logger.success(`Removed ${spec.key} from the encrypted store`);
}

/** Live-validates Graph and S3 connectivity with the effective config. */
async function execute_validate(): Promise<void> {
  const { merged } = read_sources();
  const graph_ok = await probe_graph(merged);
  const s3_ok = await probe_s3(merged);
  if (!graph_ok || !s3_ok) {
    process.exitCode = 1;
  }
}

/** Probes the service group a field belongs to, once all its fields are set. */
async function probe_group_if_complete(
  field: keyof AtlasConfig,
  merged: Partial<AtlasConfig>,
): Promise<void> {
  if (GRAPH_FIELDS.includes(field)) {
    if (GRAPH_FIELDS.every((f) => merged[f] !== undefined)) {
      await probe_graph(merged);
    } else {
      logger.info('Graph credentials incomplete -- skipping live validation for now.');
    }
    return;
  }
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

/** Requests a Graph token with the client credentials; logs the outcome. */
async function probe_graph(config: Partial<AtlasConfig>): Promise<boolean> {
  if (!GRAPH_FIELDS.every((f) => config[f] !== undefined)) {
    logger.warn('Graph credentials incomplete -- set tenant.id, client.id, client.secret');
    return false;
  }
  try {
    const credential = new ClientSecretCredential(
      config.tenant_id as string,
      config.client_id as string,
      config.client_secret as string,
    );
    await credential.getToken('https://graph.microsoft.com/.default');
    logger.success('Microsoft Graph: token acquired (tenant and credentials valid)');
    return true;
  } catch (err) {
    logger.error(`Microsoft Graph validation failed: ${(err as Error).message}`);
    return false;
  }
}

/** Lists buckets on the configured S3 endpoint; logs the outcome. */
async function probe_s3(config: Partial<AtlasConfig>): Promise<boolean> {
  if (!S3_FIELDS.every((f) => config[f] !== undefined)) {
    logger.warn('S3 settings incomplete -- set s3.endpoint, s3.access-key, s3.secret-key');
    return false;
  }
  const client = create_s3_client({
    s3_endpoint: config.s3_endpoint as string,
    s3_access_key: config.s3_access_key as string,
    s3_secret_key: config.s3_secret_key as string,
    s3_region: config.s3_region ?? 'us-east-1',
  });
  try {
    await client.send(new ListBucketsCommand({}));
    logger.success('S3: endpoint reachable and credentials accepted');
    return true;
  } catch (err) {
    logger.error(`S3 validation failed: ${(err as Error).message}`);
    return false;
  } finally {
    client.destroy();
  }
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
