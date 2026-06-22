import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  load_config,
  try_load_config_file,
  read_env_overrides,
  merge_and_validate,
} from '@/utils/config';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');
vi.mock('dotenv', () => ({ config: vi.fn() }));

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

  describe('try_load_config_file', () => {
    it('returns parsed contents when atlas.config.json exists in cwd', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes('atlas.config.json') && !String(p).includes('.atlas');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(FULL_CONFIG));

      const result = try_load_config_file();
      expect(result).toEqual(FULL_CONFIG);
    });

    it('returns empty object when no config file is found', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(try_load_config_file()).toEqual({});
    });
  });

  describe('load_config', () => {
    it('merges file and env with env taking precedence', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes('atlas.config.json') && !String(p).includes('.atlas');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(FULL_CONFIG));

      process.env['ATLAS_CLIENT_SECRET'] = 'env-override';

      const result = load_config();
      expect(result.tenant_id).toBe('tid');
      expect(result.client_secret).toBe('env-override');
    });

    it('works with env vars only (no config file)', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      set_all_env();

      const result = load_config();
      expect(result.tenant_id).toBe('tid');
      expect(result.s3_endpoint).toBe('http://localhost:9000');
    });

    it('throws when config is incomplete', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(() => load_config()).toThrow('Missing required config fields');
    });
  });
});
