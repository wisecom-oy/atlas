import { Buffer } from 'node:buffer';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ConfigError } from '@wisecom/atlas-types';
import type { AtlasInstanceConfig } from '@wisecom/atlas-types';

/** Validates explicit instance configuration without I/O and maps it to the internal config. */
export function normalize_config(config: AtlasInstanceConfig): AtlasConfig {
  if (!config || typeof config !== 'object') {
    throw new ConfigError('Atlas instance configuration must be an object.');
  }
  assert_required_field(config.tenantId, 'tenantId');
  assert_required_field(config.clientId, 'clientId');
  assert_required_field(config.clientSecret, 'clientSecret');
  assert_required_field(config.s3Endpoint, 's3Endpoint');
  assert_required_field(config.s3AccessKey, 's3AccessKey');
  assert_required_field(config.s3SecretKey, 's3SecretKey');
  assert_required_field(config.encryptionPassphrase, 'encryptionPassphrase');
  validate_endpoint(config.s3Endpoint);
  if (Buffer.byteLength(config.encryptionPassphrase, 'utf8') < 14) {
    throw new ConfigError('encryptionPassphrase must contain at least 14 UTF-8 bytes.');
  }

  return {
    tenant_id: config.tenantId,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    s3_endpoint: config.s3Endpoint,
    s3_access_key: config.s3AccessKey,
    s3_secret_key: config.s3SecretKey,
    s3_region: config.s3Region || 'us-east-1',
    encryption_passphrase: config.encryptionPassphrase,
  };
}

function assert_required_field(value: unknown, field_name: keyof AtlasInstanceConfig): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`${field_name} must be a nonblank string.`);
  }
}

function validate_endpoint(endpoint: string): void {
  const message =
    's3Endpoint must be an absolute HTTP(S) URL with a hostname and no credentials, query or fragment.';
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigError(message);
  }
  if (
    !/^https?:\/\/[^/\\\s]/i.test(endpoint) ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    endpoint.includes('?') ||
    endpoint.includes('#')
  ) {
    throw new ConfigError(message);
  }
}
