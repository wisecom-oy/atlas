import { describe, it, expect } from 'vitest';
import { scryptSync } from 'node:crypto';
import {
  DEFAULT_KDF_STRATEGY,
  KDF_SCRYPT,
  SCRYPT_PARAMS_LENGTH,
  ScryptKdfStrategy,
} from '@/adapters/keystore/kdf-strategy';

describe('ScryptKdfStrategy', () => {
  const passphrase = Buffer.from('unit-test-passphrase', 'utf-8');
  const tenant_id = 'tenant-1';

  it('generate_params produces 38-byte blocks with N=65536', () => {
    const strategy = new ScryptKdfStrategy();
    const params = strategy.generate_params(passphrase.length);
    expect(params.length).toBe(SCRYPT_PARAMS_LENGTH);
    expect(params.readUInt32BE(0)).toBe(65536);
    expect(params.readUInt8(4)).toBe(8);
    expect(params.readUInt8(5)).toBe(1);
  });

  it('derive_kek matches scryptSync with length-prefixed tenant domain salt', () => {
    const strategy = new ScryptKdfStrategy();
    const params = strategy.generate_params(passphrase.length);
    const derived = strategy.derive_kek(passphrase, params, tenant_id);

    const salt = params.subarray(6, SCRYPT_PARAMS_LENGTH);
    const tid = Buffer.from(tenant_id, 'utf-8');
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(tid.length, 0);
    const effective_salt = Buffer.concat([prefix, tid, salt]);
    const expected = scryptSync(passphrase, effective_salt, 32, {
      N: params.readUInt32BE(0),
      r: params.readUInt8(4),
      p: params.readUInt8(5),
      maxmem: 128 * 1024 * 1024,
    });
    expect(derived.equals(expected)).toBe(true);
  });

  it('different tenant_ids produce different KEKs from the same params', () => {
    const strategy = new ScryptKdfStrategy();
    const params = strategy.generate_params(passphrase.length);
    const kek_a = strategy.derive_kek(passphrase, params, 'tenant-a');
    const kek_b = strategy.derive_kek(passphrase, params, 'tenant-b');
    expect(kek_a.equals(kek_b)).toBe(false);
  });

  it('generate_params uses different salts across calls', () => {
    const strategy = new ScryptKdfStrategy();
    const p1 = strategy.generate_params(passphrase.length);
    const p2 = strategy.generate_params(passphrase.length);
    expect(p1.subarray(6).equals(p2.subarray(6))).toBe(false);
  });

  it('DEFAULT_KDF_STRATEGY exposes scrypt id', () => {
    expect(DEFAULT_KDF_STRATEGY.kdf_id).toBe(KDF_SCRYPT);
  });

  it('rejects N that is not a power of 2', () => {
    const strategy = new ScryptKdfStrategy();
    const params = strategy.generate_params(passphrase.length);
    params.writeUInt32BE(12345, 0);
    expect(() => strategy.derive_kek(passphrase, params, tenant_id)).toThrow('power of 2');
  });

  it('rejects N below the minimum (2^14)', () => {
    const strategy = new ScryptKdfStrategy();
    const params = strategy.generate_params(passphrase.length);
    params.writeUInt32BE(2, 0);
    expect(() => strategy.derive_kek(passphrase, params, tenant_id)).toThrow('below minimum');
  });

  it('rejects N above the safety ceiling (2^20)', () => {
    const strategy = new ScryptKdfStrategy();
    const params = strategy.generate_params(passphrase.length);
    params.writeUInt32BE(1 << 21, 0);
    expect(() => strategy.derive_kek(passphrase, params, tenant_id)).toThrow('exceeds maximum');
  });

  it('rejects r=0 and p=0', () => {
    const strategy = new ScryptKdfStrategy();
    const params = strategy.generate_params(passphrase.length);
    params.writeUInt8(0, 4);
    expect(() => strategy.derive_kek(passphrase, params, tenant_id)).toThrow('r out of range');

    const params2 = strategy.generate_params(passphrase.length);
    params2.writeUInt8(0, 5);
    expect(() => strategy.derive_kek(passphrase, params2, tenant_id)).toThrow('p out of range');
  });

  it('rejects wrong params buffer length', () => {
    const strategy = new ScryptKdfStrategy();
    expect(() => strategy.derive_kek(passphrase, Buffer.alloc(10), tenant_id)).toThrow(
      'Invalid scrypt params length',
    );
  });
});
