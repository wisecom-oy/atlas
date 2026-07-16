import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  read_secure_config,
  write_secure_config,
  type SecureStoreOptions,
} from '@/utils/secure-config-store';

describe('secure-config-store (file keyring)', () => {
  let base_dir: string;
  let options: SecureStoreOptions;

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
    write_secure_config({ tenant_id: 'tid', client_secret: 's3cret-value' }, options);

    expect(read_secure_config(options)).toEqual({
      tenant_id: 'tid',
      client_secret: 's3cret-value',
    });
  });

  it('stores ciphertext only -- plaintext never touches disk', () => {
    write_secure_config({ client_secret: 'hunter2-hunter2' }, options);

    const raw = readFileSync(join(base_dir, 'config.enc'));
    expect(raw.includes('hunter2-hunter2')).toBe(false);
    expect(raw.includes('client_secret')).toBe(false);
  });

  it('overwrites the store on subsequent writes', () => {
    write_secure_config({ tenant_id: 'a' }, options);
    write_secure_config({ tenant_id: 'b', s3_region: 'eu-north-1' }, options);

    expect(read_secure_config(options)).toEqual({ tenant_id: 'b', s3_region: 'eu-north-1' });
  });

  it('deletes the store file when writing an empty object', () => {
    write_secure_config({ tenant_id: 'a' }, options);
    write_secure_config({}, options);

    expect(existsSync(join(base_dir, 'config.enc'))).toBe(false);
    expect(read_secure_config(options)).toEqual({});
  });

  it('fails loudly on a tampered store', () => {
    write_secure_config({ tenant_id: 'a' }, options);
    const file_path = join(base_dir, 'config.enc');
    const data = readFileSync(file_path);
    data[data.length - 1] = data[data.length - 1]! ^ 0xff;
    writeFileSync(file_path, data);

    expect(() => read_secure_config(options)).toThrow(/wrong key or tampered/);
  });

  it('fails loudly when the store exists but the key is gone', () => {
    write_secure_config({ tenant_id: 'a' }, options);
    rmSync(join(base_dir, 'config.key'));

    expect(() => read_secure_config(options)).toThrow(/encryption key was not found/);
  });

  it.skipIf(platform() === 'win32')('writes store and key with 0600 permissions', () => {
    write_secure_config({ tenant_id: 'a' }, options);

    expect(statSync(join(base_dir, 'config.enc')).mode & 0o077).toBe(0);
    expect(statSync(join(base_dir, 'config.key')).mode & 0o077).toBe(0);
  });
});
