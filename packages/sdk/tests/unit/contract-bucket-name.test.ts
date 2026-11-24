import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type { AtlasInstance, AtlasInstanceConfig } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';
import * as contract from '@/contract';
import * as sdk from '@/index';

const TENANT_ID = '11111111-2222-3333-4444-555555555555';

const valid_config: AtlasInstanceConfig = {
  tenantId: TENANT_ID,
  clientId: '00000000-0000-0000-0000-000000000002',
  clientSecret: '<redacted>',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: '<redacted>',
  s3SecretKey: '<redacted>',
  encryptionPassphrase: 'correct horse battery staple',
};

let instance: AtlasInstance | undefined;

beforeEach(() => {
  const refuse_io = () => {
    throw new Error('Unexpected HTTP request during construction');
  };
  vi.spyOn(http, 'request').mockImplementation(refuse_io);
  vi.spyOn(https, 'request').mockImplementation(refuse_io);
});

afterEach(async () => {
  await instance?.dispose();
  instance = undefined;
  vi.restoreAllMocks();
});

/** Whether createAtlasInstance accepts `s3Bucket`; it validates without any S3 request. */
function sdk_accepts_bucket(bucket: string): boolean {
  try {
    instance = createAtlasInstance({ ...valid_config, s3Bucket: bucket });
    return true;
  } catch (err) {
    if (err instanceof ConfigError) return false;
    throw err;
  }
}

describe('contract tenantBucketName', () => {
  it('derives atlas-<tenantId>', () => {
    expect(contract.tenantBucketName(TENANT_ID)).toBe(`atlas-${TENANT_ID}`);
  });

  it('keeps the case of the tenant ID it is given', () => {
    expect(contract.tenantBucketName('Contoso.onmicrosoft.com')).toBe(
      'atlas-Contoso.onmicrosoft.com',
    );
  });
});

describe('contract isValidBucketName agrees with createAtlasInstance', () => {
  it.each([
    'abc',
    'a'.repeat(63),
    'atlas-contoso.backup',
    'ab',
    'a'.repeat(64),
    'Atlas-contoso',
    '-atlas',
    'atlas-',
    '.atlas',
    'atlas.',
    'atlas..contoso',
  ])('%j', (bucket) => {
    expect(sdk_accepts_bucket(bucket)).toBe(contract.isValidBucketName(bucket));
  });
});

describe('main entry', () => {
  it('re-exports the same bucket bindings, not copies', () => {
    expect(sdk.tenantBucketName).toBe(contract.tenantBucketName);
    expect(sdk.isValidBucketName).toBe(contract.isValidBucketName);
  });
});
