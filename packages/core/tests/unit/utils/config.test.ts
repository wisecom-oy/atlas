import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { load_config, read_env_overrides, merge_and_validate } from '@/utils/config';
import * as fs from 'node:fs';
import { read_secure_config } from '@/utils/secure-config-store';

vi.mock('node:fs');
vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('@/utils/secure-config-store', () => ({ read_secure_config: vi.fn(() => ({})) }));

const ALL_ENV_KEYS = [
  'ATLAS_TENANT_ID',
  'ATLAS_CLIENT_ID',
  'ATLAS_CLIENT_SECRET',
  'ATLAS_S3_ENDPOINT',
  'ATLAS_S3_ACCESS_KEY',
  'ATLAS_S3_SECRET_KEY',
  'ATLAS_S3_REGION',
  'ATLAS_ENCRYPTION_PASSPHRASE',
];

const FULL_CONFIG = {
  tenant_id: 'tid',
  client_id: 'cid',
  client_secret: 'secret',
  s3_endpoint: 'http://localhost:9000',
  s3_access_key: 'access',
  s3_secret_key: 'secret-key',
  s3_region: 'us-east-1',
  encryption_passphrase: 'passphrase',
};

function set_all_env(): void {
  process.env['ATLAS_TENANT_ID'] = 'tid';
  process.env['ATLAS_CLIENT_ID'] = 'cid';
  process.env['ATLAS_CLIENT_SECRET'] = 'secret';
  process.env['ATLAS_S3_ENDPOINT'] = 'http://localhost:9000';
  process.env['ATLAS_S3_ACCESS_KEY'] = 'access';
  process.env['ATLAS_S3_SECRET_KEY'] = 'secret-key';
  process.env['ATLAS_S3_REGION'] = 'us-east-1';
  process.env['ATLAS_ENCRYPTION_PASSPHRASE'] = 'passphrase';
}

function clear_all_env(): void {
  for (const key of ALL_ENV_KEYS) {
    delete process.env[key];
  }
}

describe('config', () => {
  const original_env = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...original_env };
    clear_all_env();
  });

  afterEach(() => {
    process.env = original_env;
  });

  describe('merge_and_validate', () => {
    it('returns a valid config when all fields are present', () => {
      const result = merge_and_validate(FULL_CONFIG);
      expect(result).toEqual(FULL_CONFIG);
    });

    it('defaults s3_region to us-east-1 when not provided', () => {
      const { s3_region: _, ...without_region } = FULL_CONFIG;
      const result = merge_and_validate(without_region);
      expect(result.s3_region).toBe('us-east-1');
    });

    it('throws listing all missing fields when none are provided', () => {
      expect(() => merge_and_validate({})).toThrow('Missing required config fields');
      expect(() => merge_and_validate({})).toThrow('tenant_id');
      expect(() => merge_and_validate({})).toThrow('s3_endpoint');
      expect(() => merge_and_validate({})).toThrow('encryption_passphrase');
    });

    it('throws listing only the missing fields', () => {
      expect(() => merge_and_validate({ tenant_id: 'tid' })).toThrow('client_id');
      expect(() => merge_and_validate({ tenant_id: 'tid' })).not.toThrow('tenant_id');
    });
  });

  describe('read_env_overrides', () => {
    it('reads all ATLAS_* environment variables', () => {
      set_all_env();
      const result = read_env_overrides();
      expect(result.tenant_id).toBe('tid');
      expect(result.s3_endpoint).toBe('http://localhost:9000');
      expect(result.encryption_passphrase).toBe('passphrase');
    });

    it('returns empty object when no ATLAS_* vars are set', () => {
      expect(read_env_overrides()).toEqual({});
    });

    it('ignores empty string env vars', () => {
      process.env['ATLAS_TENANT_ID'] = '';
      process.env['ATLAS_CLIENT_ID'] = 'cid';
      const result = read_env_overrides();
      expect(result).toEqual({ client_id: 'cid' });
    });
  });

  describe('load_config', () => {
    it('merges the secure store and the environment, environment winning', () => {
      vi.mocked(read_secure_config).mockReturnValue(FULL_CONFIG);
      process.env['ATLAS_CLIENT_SECRET'] = 'env-override';

      const result = load_config();

      expect(result.tenant_id).toBe('tid');
      expect(result.client_secret).toBe('env-override');
    });

    it('works from environment variables alone', () => {
      vi.mocked(read_secure_config).mockReturnValue({});
      set_all_env();

      const result = load_config();

      expect(result.tenant_id).toBe('tid');
      expect(result.s3_endpoint).toBe('http://localhost:9000');
    });

    // #334: a plaintext atlas.config.json used to be a third source, found in the working
    // directory or in $HOME. It is not read at all now, so a run that still has one and nothing
    // else fails naming the two supported sources rather than picking up stale credentials.
    it('ignores a JSON config file in the working directory', () => {
      vi.mocked(read_secure_config).mockReturnValue({});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(FULL_CONFIG));

      expect(() => load_config()).toThrow('Missing required config fields');
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('throws when configuration is incomplete', () => {
      vi.mocked(read_secure_config).mockReturnValue({});

      expect(() => load_config()).toThrow('atlas config set');
    });
  });
});
