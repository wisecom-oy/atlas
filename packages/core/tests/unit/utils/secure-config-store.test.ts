import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import type { StoredConfig } from '@/utils/tenant-profiles';
import {
  read_secure_config,
  update_secure_config,
  type SecureStoreOptions,
} from '@/utils/secure-config-store';

describe('secure-config-store (file keyring)', () => {
  let base_dir: string;
  let options: SecureStoreOptions;
  const save = (values: StoredConfig): StoredConfig => update_secure_config(() => values, options);

  beforeEach(() => {
    base_dir = mkdtempSync(join(tmpdir(), 'atlas-store-'));
    options = { base_dir, keyring: 'file' };
  });

  afterEach(() => {
    rmSync(base_dir, { recursive: true, force: true });
  });

  it('returns an empty object when no store exists', () => {
    expect(read_secure_config(options)).toEqual({});
  });

  it('roundtrips values through encrypt/decrypt', () => {
    save({ tenant_id: 'tid', client_secret: 's3cret-value' });

    expect(read_secure_config(options)).toEqual({
      tenant_id: 'tid',
      client_secret: 's3cret-value',
    });
  });

  it('stores ciphertext only -- plaintext never touches disk', () => {
    save({ client_secret: 'hunter2-hunter2' });

    const raw = readFileSync(join(base_dir, 'config.enc'));
    expect(raw.includes('hunter2-hunter2')).toBe(false);
    expect(raw.includes('client_secret')).toBe(false);
  });

  it('hands the current values to the update and saves what it returns', () => {
    save({ tenant_id: 'a' });
    update_secure_config((current) => ({ ...current, s3_region: 'eu-north-1' }), options);

    expect(read_secure_config(options)).toEqual({ tenant_id: 'a', s3_region: 'eu-north-1' });
  });

  it('deletes the store file when the update returns an empty object', () => {
    save({ tenant_id: 'a' });
    save({});

    expect(existsSync(join(base_dir, 'config.enc'))).toBe(false);
    expect(read_secure_config(options)).toEqual({});
  });

  it('keeps the store and releases the lock when the update throws', () => {
    save({ tenant_id: 'a' });

    expect(() =>
      update_secure_config(() => {
        throw new Error('refused');
      }, options),
    ).toThrow('refused');

    expect(read_secure_config(options)).toEqual({ tenant_id: 'a' });
    expect(existsSync(join(base_dir, 'config.lock'))).toBe(false);
    save({ tenant_id: 'b' });
    expect(read_secure_config(options)).toEqual({ tenant_id: 'b' });
  });

  it('leaves only the store, key and nothing half-written behind', () => {
    save({ tenant_id: 'a' });
    save({ tenant_id: 'b' });

    expect(readdirSync(base_dir).sort()).toEqual(['config.enc', 'config.key']);
  });

  it('fails loudly on a tampered store', () => {
    save({ tenant_id: 'a' });
    const file_path = join(base_dir, 'config.enc');
    const data = readFileSync(file_path);
    data[data.length - 1] = data[data.length - 1]! ^ 0xff;
    writeFileSync(file_path, data);

    expect(() => read_secure_config(options)).toThrow(/wrong key or tampered/);
  });

  it('fails loudly when the store exists but the key is gone', () => {
    save({ tenant_id: 'a' });
    rmSync(join(base_dir, 'config.key'));

    expect(() => read_secure_config(options)).toThrow(/encryption key was not found/);
  });

  it.skipIf(platform() === 'win32')('writes store and key with 0600 permissions', () => {
    save({ tenant_id: 'a' });
    save({ tenant_id: 'b' });

    expect(statSync(join(base_dir, 'config.enc')).mode & 0o077).toBe(0);
    expect(statSync(join(base_dir, 'config.key')).mode & 0o077).toBe(0);
  });
});
