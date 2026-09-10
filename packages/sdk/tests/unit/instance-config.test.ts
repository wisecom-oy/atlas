import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type { AtlasInstance, AtlasInstanceConfig } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';

const valid_config: AtlasInstanceConfig = {
  tenantId: randomUUID(),
  clientId: randomUUID(),
  clientSecret: '<redacted>',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: '<redacted>',
  s3SecretKey: '<redacted>',
  encryptionPassphrase: '<redacted>'.repeat(2),
};

let instance: AtlasInstance | undefined;

beforeEach(() => {
  vi.spyOn(http, 'request').mockImplementation(() => {
    throw new Error('Unexpected HTTP request during construction');
  });
  vi.spyOn(https, 'request').mockImplementation(() => {
    throw new Error('Unexpected HTTPS request during construction');
  });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Unexpected fetch during construction'),
  );
});

afterEach(async () => {
  await instance?.dispose();
  instance = undefined;
  expect(http.request).not.toHaveBeenCalled();
  expect(https.request).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('instance configuration', () => {
  it.each<[keyof AtlasInstanceConfig, unknown]>([
    ['tenantId', undefined],
    ['clientId', ' '],
    ['clientSecret', 42],
    ['s3Endpoint', ''],
    ['s3AccessKey', null],
    ['s3SecretKey', '\t\n'],
    ['encryptionPassphrase', ' '.repeat(14)],
  ])('rejects invalid required field %s synchronously', (field, value) => {
    expect(() =>
      createAtlasInstance({ ...valid_config, [field]: value } as AtlasInstanceConfig),
    ).toThrow(ConfigError);
  });

  it('rejects a missing configuration object as ConfigError', () => {
    expect(() => createAtlasInstance(undefined as unknown as AtlasInstanceConfig)).toThrow(
      ConfigError,
    );
  });

  it.each([
    'not-a-url',
    'ftp://localhost',
    'https://',
    'http:localhost',
    'http://<redacted>@localhost',
    'http://:<redacted>@localhost',
    'http://localhost?',
    'http://localhost#section',
  ])('rejects an unusable S3 endpoint: %s', (endpoint) => {
    expect(() => createAtlasInstance({ ...valid_config, s3Endpoint: endpoint })).toThrow(
      ConfigError,
    );
  });

  it('enforces the 14-byte boundary while accepting localhost HTTP without I/O', () => {
    const passphrase = randomBytes(7).toString('hex');
    expect(() =>
      createAtlasInstance({ ...valid_config, encryptionPassphrase: passphrase.slice(1) }),
    ).toThrow(ConfigError);
    expect(() => {
      instance = createAtlasInstance({ ...valid_config, encryptionPassphrase: passphrase });
    }).not.toThrow();
  });

  it('measures passphrase strength in UTF-8 bytes, not JavaScript characters', () => {
    const passphrase = String.fromCodePoint(0xe9).repeat(7);
    expect(() =>
      createAtlasInstance({ ...valid_config, encryptionPassphrase: passphrase.slice(1) }),
    ).toThrow(ConfigError);
    expect(() => {
      instance = createAtlasInstance({ ...valid_config, encryptionPassphrase: passphrase });
    }).not.toThrow();
  });
});
