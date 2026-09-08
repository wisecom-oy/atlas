import { config as load_dotenv } from 'dotenv';
import { read_secure_config } from '@/utils/secure-config-store';

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

/**
 * Loads Atlas configuration from the two sources v5.0.0 supports, environment winning:
 *   1. the encrypted store at `~/.atlas/config.enc`, written by `atlas config set`
 *   2. `ATLAS_*` environment variables, exported or read from `.env` in the working directory
 *
 * A plaintext `atlas.config.json` used to be a third source, searched in the working directory
 * and then in `$HOME`. It held `client_secret` and `encryption_passphrase` in the clear, needed a
 * permission warning to compensate, and let a stale file in `$HOME` supply credentials to a run
 * somewhere else (issue #334). Throws if any required field is missing after merging.
 */
export function load_config(): AtlasConfig {
  // quiet: dotenv's load banner goes to stdout, which corrupts pipeable output
  // such as `atlas outlook read --raw > message.eml`.
  load_dotenv({ quiet: true });
  return merge_and_validate({ ...read_secure_config(), ...read_env_overrides() });
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
        'Set them via "atlas config set <key> <value>", or ATLAS_* environment variables ' +
        '(exported, or in a .env file in the current directory).',
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
