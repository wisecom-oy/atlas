import { describe, expect, it } from 'vitest';
import type { S3Config } from '@wisecom/atlas-core';
import { build_s3_client_config } from '@/adapters/s3-client.factory';

// Issue #924: the client bounds connect and idle time and retries each request on its own budget.

const BASE: S3Config = {
  s3_endpoint: 'http://127.0.0.1:9000',
  s3_region: 'us-east-1',
  s3_access_key: '<redacted>',
  s3_secret_key: '<redacted>',
};

describe('build_s3_client_config', () => {
  it('applies the default connection timeout, idle timeout and attempts', () => {
    const config = build_s3_client_config(BASE);

    expect(config.requestHandler).toEqual({ connectionTimeout: 10_000, socketTimeout: 300_000 });
    expect(config.maxAttempts).toBe(3);
  });

  it('applies configured transport settings', () => {
    const config = build_s3_client_config({
      ...BASE,
      s3_transport: { connection_timeout_ms: 2_000, idle_timeout_ms: 60_000, max_attempts: 5 },
    });

    expect(config.requestHandler).toEqual({ connectionTimeout: 2_000, socketTimeout: 60_000 });
    expect(config.maxAttempts).toBe(5);
  });

  it('never sets the wall-clock request timeout, which would cap a slow part upload', () => {
    const handler = build_s3_client_config(BASE).requestHandler as Record<string, unknown>;

    expect(handler).not.toHaveProperty('requestTimeout');
    expect(handler).not.toHaveProperty('throwOnRequestTimeout');
  });

  it('replaces the SDK token bucket with a per-request retry strategy', async () => {
    const strategy = build_s3_client_config({
      ...BASE,
      s3_transport: { connection_timeout_ms: 0, idle_timeout_ms: 0, max_attempts: 2 },
    }).retryStrategy;

    expect(strategy).toBeDefined();
    expect(strategy).toHaveProperty('refreshRetryTokenForRetry');
  });

  it('keeps the endpoint, region, credentials and path-style addressing', () => {
    const config = build_s3_client_config(BASE);

    expect(config.endpoint).toBe(BASE.s3_endpoint);
    expect(config.region).toBe('us-east-1');
    expect(config.forcePathStyle).toBe(true);
    expect(config.credentials).toEqual({
      accessKeyId: BASE.s3_access_key,
      secretAccessKey: BASE.s3_secret_key,
    });
  });
});
