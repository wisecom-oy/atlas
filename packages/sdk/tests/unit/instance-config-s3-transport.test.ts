import { describe, expect, it } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type { AtlasInstanceConfig } from '@wisecom/atlas-types';
import { normalize_config } from '@/instance-config';

// Issue #924: S3 timeouts and attempts are settable per instance.

const BASE: AtlasInstanceConfig = {
  tenantId: 'tenant-example',
  clientId: 'client-example',
  clientSecret: '<redacted>',
  s3Endpoint: 'https://storage.example.com',
  s3AccessKey: '<redacted>',
  s3SecretKey: '<redacted>',
  encryptionPassphrase: '<redacted>'.repeat(2),
};

describe('normalize_config S3 transport options', () => {
  it('leaves the transport at its defaults when no option is given', () => {
    expect(normalize_config(BASE)).not.toHaveProperty('s3_transport');
  });

  it('maps the options, filling the ones not given from the defaults', () => {
    expect(
      normalize_config({ ...BASE, s3IdleTimeoutMs: 60_000, s3MaxAttempts: 5 }).s3_transport,
    ).toEqual({ connection_timeout_ms: 10_000, idle_timeout_ms: 60_000, max_attempts: 5 });
  });

  it('accepts 0 to disable the connection timeout', () => {
    expect(normalize_config({ ...BASE, s3ConnectionTimeoutMs: 0 }).s3_transport).toMatchObject({
      connection_timeout_ms: 0,
    });
  });

  it.each([
    ['s3ConnectionTimeoutMs', 500],
    ['s3IdleTimeoutMs', -1],
    ['s3MaxAttempts', 0],
    ['s3MaxAttempts', 2.5],
  ] as const)('refuses %s = %s with a ConfigError naming the option', (option, value) => {
    const normalize = (): unknown => normalize_config({ ...BASE, [option]: value });

    expect(normalize).toThrow(ConfigError);
    expect(normalize).toThrow(option);
  });
});
