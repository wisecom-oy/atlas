import { describe, it, expect } from 'vitest';
import { CONFIG_KEYS, find_config_key, mask_secret } from '@/utils/config-keys';

function validate(key: string, value: string): string | null {
  const spec = find_config_key(key);
  if (!spec) throw new Error(`missing spec ${key}`);
  return spec.validate(value);
}

describe('config-keys', () => {
  it('covers every AtlasConfig field exactly once', () => {
    const fields = CONFIG_KEYS.map((k) => k.field).sort();
    expect(fields).toEqual(
      [
        'tenant_id',
        'client_id',
        'client_secret',
        's3_endpoint',
        's3_access_key',
        's3_secret_key',
        's3_region',
        'encryption_passphrase',
      ].sort(),
    );
  });

  it('accepts a GUID or tenant domain for tenant.id', () => {
    expect(validate('tenant.id', '4fa2a706-b26a-4bbe-9b1c-1e671b586b8f')).toBeNull();
    expect(validate('tenant.id', 'contoso.onmicrosoft.com')).toBeNull();
    expect(validate('tenant.id', 'not a tenant')).toMatch(/GUID/);
  });

  it('requires a GUID for client.id', () => {
    expect(validate('client.id', '4fa2a706-b26a-4bbe-9b1c-1e671b586b8f')).toBeNull();
    expect(validate('client.id', 'contoso.onmicrosoft.com')).toMatch(/GUID/);
  });

  it('rejects whitespace and empty secrets', () => {
    expect(validate('client.secret', 'abc~DEF123')).toBeNull();
    expect(validate('client.secret', '')).not.toBeNull();
    expect(validate('s3.access-key', 'two words')).not.toBeNull();
  });

  it('requires an http(s) URL for s3.endpoint', () => {
    expect(validate('s3.endpoint', 'https://s3.example.com')).toBeNull();
    expect(validate('s3.endpoint', 'http://localhost:9000')).toBeNull();
    expect(validate('s3.endpoint', 'ftp://files.example.com')).toMatch(/http/);
    expect(validate('s3.endpoint', 'localhost:9000')).toMatch(/http/);
  });

  it('enforces a minimum passphrase length', () => {
    expect(validate('encryption.passphrase', 'short')).toMatch(/12/);
    expect(validate('encryption.passphrase', 'a-long-enough-passphrase')).toBeNull();
  });

  it('masks secrets keeping only the tail, fully masking short ones', () => {
    expect(mask_secret('supersecretvalue')).toBe('****alue');
    expect(mask_secret('8chars!!')).toBe('****');
    expect(mask_secret('ab')).toBe('****');
  });
});
