import type { AtlasConfig } from '@/utils/config';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
const MIN_PASSPHRASE_LENGTH = 12;

export interface ConfigKeySpec {
  /** Dotted CLI key, e.g. "tenant.id". */
  readonly key: string;
  readonly field: keyof AtlasConfig;
  /** Secrets are masked in get/list output. */
  readonly secret: boolean;
  readonly description: string;
  /** Returns an error message, or null when the value is acceptable. */
  readonly validate: (value: string) => string | null;
}

/** All configuration keys addressable via "atlas config". */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    key: 'tenant.id',
    field: 'tenant_id',
    secret: false,
    description: 'Microsoft Entra tenant (GUID or *.onmicrosoft.com domain)',
    validate: (v) =>
      GUID_RE.test(v) || DOMAIN_RE.test(v)
        ? null
        : 'must be a GUID or a tenant domain like contoso.onmicrosoft.com',
  },
  {
    key: 'client.id',
    field: 'client_id',
    secret: false,
    description: 'Entra app registration (client) ID',
    validate: (v) => (GUID_RE.test(v) ? null : 'must be a GUID'),
  },
  {
    key: 'client.secret',
    field: 'client_secret',
    secret: true,
    description: 'Entra app client secret',
    validate: (v) => (/\s/.test(v) || v.length === 0 ? 'must be a non-empty single token' : null),
  },
  {
    key: 's3.endpoint',
    field: 's3_endpoint',
    secret: false,
    description: 'S3-compatible endpoint URL',
    validate: (v) => {
      try {
        const url = new URL(v);
        return url.protocol === 'http:' || url.protocol === 'https:'
          ? null
          : 'must use http:// or https://';
      } catch {
        return 'must be a valid URL';
      }
    },
  },
  {
    key: 's3.access-key',
    field: 's3_access_key',
    secret: false,
    description: 'S3 access key ID',
    validate: (v) => (/\s/.test(v) || v.length === 0 ? 'must be a non-empty single token' : null),
  },
  {
    key: 's3.secret-key',
    field: 's3_secret_key',
    secret: true,
    description: 'S3 secret access key',
    validate: (v) => (/\s/.test(v) || v.length === 0 ? 'must be a non-empty single token' : null),
  },
  {
    key: 's3.region',
    field: 's3_region',
    secret: false,
    description: 'S3 region (default us-east-1)',
    validate: (v) => (/^[a-z0-9-]+$/.test(v) ? null : 'must be lowercase letters, digits, dashes'),
  },
  {
    key: 'encryption.passphrase',
    field: 'encryption_passphrase',
    secret: true,
    description: 'Passphrase protecting the per-tenant encryption keys',
    validate: (v) =>
      v.length >= MIN_PASSPHRASE_LENGTH
        ? null
        : `must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
  },
];

/** Looks up a key spec by its dotted CLI name. */
export function find_config_key(key: string): ConfigKeySpec | undefined {
  return CONFIG_KEYS.find((spec) => spec.key === key);
}

/** Masks a secret for display, keeping the last four characters. */
export function mask_secret(value: string): string {
  return value.length <= 8 ? '****' : `${'*'.repeat(4)}${value.slice(-4)}`;
}
