import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { load_config, load_tenant_profile } from '@/utils/config';
import { find_profile, normalize_stored_config } from '@/utils/tenant-profiles';

vi.mock('node:fs');
vi.mock('node:os');
vi.mock('dotenv', () => ({ config: vi.fn() }));

const SHARED = {
  s3_endpoint: 'http://localhost:9000',
  s3_access_key: 'access',
  s3_secret_key: 'secret-key',
  encryption_passphrase: 'passphrase',
};
const PROD = { tenant_id: 'tid-prod', client_id: 'cid-prod', client_secret: 'secret-prod' };
const DR = { tenant_id: 'tid-dr', client_id: 'cid-dr', client_secret: 'secret-dr' };

/** Serves `contents` as ./atlas.config.json; the encrypted store is absent. */
function config_file(contents: object): void {
  vi.mocked(os.homedir).mockReturnValue('/home/testuser');
  vi.mocked(fs.existsSync).mockImplementation(
    (p) => String(p).includes('atlas.config.json') && !String(p).includes('.atlas'),
  );
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(contents));
}

describe('tenant profiles', () => {
  const original_env = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...original_env };
    for (const key of Object.keys(process.env))
      if (key.startsWith('ATLAS_')) delete process.env[key];
  });

  afterEach(() => {
    process.env = original_env;
  });

  describe('load_config', () => {
    it('takes Graph credentials from the active profile and shared settings from the top level', () => {
      config_file({ ...SHARED, tenants: { prod: PROD, dr: DR }, active_tenant: 'dr' });

      expect(load_config()).toMatchObject({ ...SHARED, ...DR });
    });

    it('prefers the explicit profile over ATLAS_PROFILE, and ATLAS_PROFILE over the active one', () => {
      config_file({ ...SHARED, tenants: { prod: PROD, dr: DR }, active_tenant: 'prod' });
      process.env['ATLAS_PROFILE'] = 'dr';

      expect(load_config().tenant_id).toBe('tid-dr');
      expect(load_config({ profile: 'prod' }).tenant_id).toBe('tid-prod');
    });

    it('reads legacy top-level Graph fields as the default profile', () => {
      config_file({ ...SHARED, ...PROD, tenants: { dr: DR } });

      expect(load_config().tenant_id).toBe('tid-prod');
      expect(load_config({ profile: 'default' }).tenant_id).toBe('tid-prod');
    });

    it('rejects an unknown profile, naming the known ones', () => {
      config_file({ ...SHARED, tenants: { prod: PROD, dr: DR } });

      expect(() => load_config({ profile: 'staging' })).toThrow(
        'Unknown tenant profile "staging". Known profiles: dr, prod.',
      );
    });

    it('applies ATLAS_* Graph overrides to the selected profile', () => {
      config_file({ ...SHARED, tenants: { prod: PROD }, active_tenant: 'prod' });
      process.env['ATLAS_CLIENT_SECRET'] = 'env-secret';

      expect(load_config()).toMatchObject({ tenant_id: 'tid-prod', client_secret: 'env-secret' });
    });
  });

  describe('load_tenant_profile', () => {
    it('ignores ATLAS_* overrides, so a second profile never turns into the selected one', () => {
      config_file({ ...SHARED, tenants: { prod: PROD, dr: DR }, active_tenant: 'prod' });
      process.env['ATLAS_TENANT_ID'] = 'tid-env';

      expect(load_tenant_profile('dr')).toEqual(DR);
    });

    it('names the missing fields of an incomplete profile', () => {
      config_file({ ...SHARED, tenants: { dr: { tenant_id: 'tid-dr' } } });

      expect(() => load_tenant_profile('dr')).toThrow(
        'Tenant profile "dr" is missing client_id, client_secret.',
      );
    });
  });

  it('merges a profile field by field, the encrypted store winning over the file', () => {
    const file = { tenants: { prod: PROD } };
    const secure = { tenants: { prod: { client_secret: 'rotated' } } };

    expect(find_profile('prod', file, secure)).toEqual({ ...PROD, client_secret: 'rotated' });
  });

  it('moves legacy top-level Graph fields into tenants.default when normalizing', () => {
    expect(normalize_stored_config({ ...SHARED, ...PROD, active_tenant: 'default' })).toEqual({
      ...SHARED,
      tenants: { default: PROD },
      active_tenant: 'default',
    });
  });

  it('rejects a tenants field that is not an object', () => {
    config_file({ ...SHARED, tenants: ['prod'] });

    expect(() => load_config()).toThrow('Config field "tenants" must be an object');
  });
});
