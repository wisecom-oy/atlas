import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { config as load_dotenv } from 'dotenv';
import { logger } from '@/utils/logger';
import { read_secure_config } from '@/utils/secure-config-store';
import {
  assert_override_keeps_one_identity,
  find_graph_env_overrides,
  warn_graph_env_overrides,
} from '@/utils/graph-env-overrides';
import {
  find_profile,
  profile_names,
  select_profile_name,
  shared_settings,
  unknown_profile_message,
  DEFAULT_PROFILE,
  type StoredConfig,
} from '@/utils/tenant-profiles';

export interface GraphConfig {
  readonly tenant_id: string;
  readonly client_id: string;
  readonly client_secret: string;
}

export interface S3Config {
  readonly s3_endpoint: string;
  readonly s3_access_key: string;
  readonly s3_secret_key: string;
  readonly s3_region: string;
}

export interface CryptoConfig {
  readonly encryption_passphrase: string;
}

export type AtlasConfig = GraphConfig & S3Config & CryptoConfig;

export const ATLAS_CONFIG_TOKEN = Symbol.for('AtlasConfig');

const CONFIG_FILE_NAMES = ['atlas.config.json', join('.atlas', 'config.json')];

const ENV_MAP: Record<string, keyof AtlasConfig> = {
  ATLAS_TENANT_ID: 'tenant_id',
  ATLAS_CLIENT_ID: 'client_id',
  ATLAS_CLIENT_SECRET: 'client_secret',
  ATLAS_S3_ENDPOINT: 's3_endpoint',
  ATLAS_S3_ACCESS_KEY: 's3_access_key',
  ATLAS_S3_SECRET_KEY: 's3_secret_key',
  ATLAS_S3_REGION: 's3_region',
  ATLAS_ENCRYPTION_PASSPHRASE: 'encryption_passphrase',
};

/** Options for {@link load_config}. */
export interface LoadConfigOptions {
  /** Tenant profile to use, from the `--profile` flag; falls back to `ATLAS_PROFILE`. */
  readonly profile?: string | undefined;
}

/**
 * Loads Atlas configuration by merging sources in this order
 * (later sources override earlier ones):
 *   1. atlas.config.json file
 *   2. Encrypted secure store (~/.atlas/config.enc, managed via "atlas config" and "atlas tenants")
 *   3. .env file (loaded into process.env via dotenv, does NOT overwrite existing vars)
 *   4. Real environment variables (always win)
 * Graph credentials come from the selected tenant profile, and ATLAS_* Graph variables override
 * that profile only. Warns on stderr when they replace a profile value, and throws when a partial
 * override changes its tenant or client ID, the profile is unknown, or a required field is missing.
 */
export function load_config(options: LoadConfigOptions = {}): AtlasConfig {
  // quiet: dotenv's load banner goes to stdout, which corrupts pipeable output
  // such as `atlas outlook read --raw > message.eml`.
  load_dotenv({ quiet: true });
  const file_config = try_load_config_file();
  const secure_config = read_secure_config();
  const name = select_profile_name(options.profile, file_config, secure_config);
  const profile = find_profile(name, file_config, secure_config);
  if (profile === undefined && name !== DEFAULT_PROFILE) {
    throw new Error(unknown_profile_message(name, profile_names(file_config, secure_config)));
  }
  const env = read_env_overrides();
  const overridden = find_graph_env_overrides(profile, env);
  assert_override_keeps_one_identity(name, env, overridden);
  warn_graph_env_overrides(name, overridden);
  return merge_and_validate({
    ...shared_settings(file_config),
    ...shared_settings(secure_config),
    ...profile,
    ...env,
  });
}

/**
 * Loads one profile's Graph credentials from the file and the store. Environment variables are
 * deliberately ignored: they override the selected profile, and applying them here as well would
 * quietly turn a second profile into the first.
 */
export function load_tenant_profile(name: string): GraphConfig {
  const file_config = try_load_config_file();
  const secure_config = read_secure_config();
  const profile = find_profile(name, file_config, secure_config);
  if (profile === undefined) {
    throw new Error(unknown_profile_message(name, profile_names(file_config, secure_config)));
  }
  const missing = (['tenant_id', 'client_id', 'client_secret'] as const).filter((f) => !profile[f]);
  if (missing.length > 0) {
    throw new Error(`Tenant profile "${name}" is missing ${missing.join(', ')}.`);
  }
  return {
    tenant_id: profile.tenant_id!,
    client_id: profile.client_id!,
    client_secret: profile.client_secret!,
  };
}

/**
 * Searches for a config file in the current directory and the user's
 * home directory. Returns the parsed contents, or an empty object if
 * no file is found.
 */
export function try_load_config_file(): StoredConfig {
  const search_dirs = [process.cwd(), homedir()];

  for (const dir of search_dirs) {
    for (const name of CONFIG_FILE_NAMES) {
      const file_path = resolve(dir, name);
      if (existsSync(file_path)) {
        return parse_config_file(file_path);
      }
    }
  }

  return {};
}

/** Reads and JSON-parses a single config file. */
function parse_config_file(file_path: string): StoredConfig {
  warn_if_world_readable(file_path);
  const raw = readFileSync(file_path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Config file ${file_path} must contain a JSON object`);
  }

  return parsed;
}

/** Warns if a config file has group- or world-readable permissions (Unix only). */
function warn_if_world_readable(file_path: string): void {
  if (platform() === 'win32') return;
  try {
    const stat = statSync(file_path);
    const other_bits = stat.mode & 0o077;
    if (other_bits !== 0) {
      const mode_str = `0${(stat.mode & 0o777).toString(8)}`;
      logger.warn(
        `Config file ${file_path} has overly permissive permissions (mode ${mode_str}). ` +
          `Recommended: chmod 600 ${file_path}`,
      );
    }
  } catch {
    /* stat failure is non-fatal — config will fail at read anyway */
  }
}

/**
 * Reads ATLAS_* environment variables and maps them to config fields.
 * Only includes variables that are actually set.
 */
export function read_env_overrides(): Partial<AtlasConfig> {
  const overrides: Partial<AtlasConfig> = {};

  for (const [env_key, config_key] of Object.entries(ENV_MAP)) {
    const value = process.env[env_key];
    if (value !== undefined && value !== '') {
      (overrides as Record<string, string>)[config_key] = value;
    }
  }

  return overrides;
}

/**
 * Validates that all required fields are present and returns a
 * fully typed AtlasConfig. Throws a descriptive error listing
 * every missing field.
 */
export function merge_and_validate(partial: Partial<AtlasConfig>): AtlasConfig {
  const required_fields: (keyof AtlasConfig)[] = [
    'tenant_id',
    'client_id',
    'client_secret',
    's3_endpoint',
    's3_access_key',
    's3_secret_key',
    'encryption_passphrase',
  ];
  const missing = required_fields.filter((f) => !partial[f]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required config fields: ${missing.join(', ')}. ` +
        'Add tenant credentials with "atlas tenants add", and set storage and encryption via ' +
        '"atlas config set <key> <value>", atlas.config.json, or ATLAS_* environment variables.',
    );
  }

  return {
    tenant_id: partial.tenant_id!,
    client_id: partial.client_id!,
    client_secret: partial.client_secret!,
    s3_endpoint: partial.s3_endpoint!,
    s3_access_key: partial.s3_access_key!,
    s3_secret_key: partial.s3_secret_key!,
    s3_region: partial.s3_region || 'us-east-1',
    encryption_passphrase: partial.encryption_passphrase!,
  };
}
