import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type { AtlasInstance, AtlasInstanceConfig } from '@wisecom/atlas-types';
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';
import * as contract from '@/contract';
import * as sdk from '@/index';

/** Nine characters, four of them two-byte: one byte under the floor. */
const THIRTEEN_BYTES = 'ääääabcde';
/** Ten characters: exactly the floor. */
const FOURTEEN_BYTES = 'ääääabcdef';

const valid_config: AtlasInstanceConfig = {
  tenantId: randomUUID(),
  clientId: randomUUID(),
  clientSecret: '<redacted>',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: '<redacted>',
  s3SecretKey: '<redacted>',
  encryptionPassphrase: FOURTEEN_BYTES,
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

describe('contract passphrase floor', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(contract.passphraseByteLength(THIRTEEN_BYTES)).toBe(13);
    expect(contract.passphraseByteLength(FOURTEEN_BYTES)).toBe(14);
    expect(contract.MIN_PASSPHRASE_BYTES).toBe(14);
  });

  it('rejects 13 bytes in the helper and in createAtlasInstance alike', () => {
    expect(contract.isAcceptablePassphrase(THIRTEEN_BYTES)).toBe(false);
    expect(() =>
      createAtlasInstance({ ...valid_config, encryptionPassphrase: THIRTEEN_BYTES }),
    ).toThrow(ConfigError);
  });

  it('accepts 14 bytes in the helper and in createAtlasInstance alike', () => {
    expect(contract.isAcceptablePassphrase(FOURTEEN_BYTES)).toBe(true);
    expect(() => {
      instance = createAtlasInstance({ ...valid_config, encryptionPassphrase: FOURTEEN_BYTES });
    }).not.toThrow();
  });
});

describe('contract site id and pools', () => {
  it('keys a Graph composite site id without its hostname', () => {
    const site_guid = '11111111-1111-1111-1111-111111111111';
    const web_guid = '22222222-2222-2222-2222-222222222222';
    const composite = `contoso.sharepoint.com,${site_guid},${web_guid}`;
    expect(contract.canonicalSiteId(composite)).toBe(`${site_guid},${web_guid}`);
  });

  it('lists every pool GRAPH_SERVICE_LIMITS has, and no other', () => {
    expect([...contract.GRAPH_SERVICE_POOLS].sort()).toEqual(
      Object.keys(GRAPH_SERVICE_LIMITS).sort(),
    );
  });
});

describe('main entry', () => {
  it('re-exports the same contract bindings, not copies', () => {
    expect(sdk.MIN_PASSPHRASE_BYTES).toBe(contract.MIN_PASSPHRASE_BYTES);
    expect(sdk.passphraseByteLength).toBe(contract.passphraseByteLength);
    expect(sdk.isAcceptablePassphrase).toBe(contract.isAcceptablePassphrase);
    expect(sdk.canonicalSiteId).toBe(contract.canonicalSiteId);
    expect(sdk.GRAPH_SERVICE_POOLS).toBe(contract.GRAPH_SERVICE_POOLS);
  });
});
