import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ConfigError } from '@wisecom/atlas-types';
import { load_config } from '@/utils/config';
import {
  DEFAULT_S3_TRANSPORT,
  S3_TRANSPORT_ENV_VARS,
  build_s3_transport,
  read_env_s3_transport,
} from '@/utils/s3-transport-settings';

vi.mock('node:fs');
vi.mock('node:os');
vi.mock('dotenv', () => ({ config: vi.fn() }));

// Issue #924: S3 timeouts and attempts are bounded by default and tunable per run.

const original_env = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  process.env = { ...original_env };
  for (const key of Object.keys(process.env)) if (key.startsWith('ATLAS_')) delete process.env[key];
});

afterEach(() => {
  process.env = original_env;
});

describe('build_s3_transport', () => {
  it('returns undefined when nothing is overridden, so the client uses the defaults', () => {
    expect(build_s3_transport({}, S3_TRANSPORT_ENV_VARS)).toBeUndefined();
  });

  it('fills the settings not given from the defaults', () => {
    expect(build_s3_transport({ max_attempts: 5 }, S3_TRANSPORT_ENV_VARS)).toEqual({
      ...DEFAULT_S3_TRANSPORT,
      max_attempts: 5,
    });
  });

  it('accepts 0 to disable a timeout', () => {
    expect(
      build_s3_transport({ connection_timeout_ms: 0, idle_timeout_ms: 0 }, S3_TRANSPORT_ENV_VARS),
    ).toEqual({ ...DEFAULT_S3_TRANSPORT, connection_timeout_ms: 0, idle_timeout_ms: 0 });
  });

  it.each([
    ['idle_timeout_ms', 999],
    ['idle_timeout_ms', 3_600_001],
    ['connection_timeout_ms', 1.5],
    ['connection_timeout_ms', Number.NaN],
    ['max_attempts', 0],
    ['max_attempts', 11],
    ['max_attempts', '3'],
  ] as const)('refuses %s = %s and names the setting', (field, value) => {
    const build = (): unknown => build_s3_transport({ [field]: value }, S3_TRANSPORT_ENV_VARS);

    expect(build).toThrow(ConfigError);
    expect(build).toThrow(S3_TRANSPORT_ENV_VARS[field]);
  });
});

describe('read_env_s3_transport', () => {
  it('reads each ATLAS_S3_* variable that is set', () => {
    process.env['ATLAS_S3_CONNECTION_TIMEOUT_MS'] = '5000';
    process.env['ATLAS_S3_IDLE_TIMEOUT_MS'] = '60000';
    process.env['ATLAS_S3_MAX_ATTEMPTS'] = '4';

    expect(read_env_s3_transport()).toEqual({
      connection_timeout_ms: 5_000,
      idle_timeout_ms: 60_000,
      max_attempts: 4,
    });
  });

  it('ignores empty variables', () => {
    process.env['ATLAS_S3_IDLE_TIMEOUT_MS'] = '';

    expect(read_env_s3_transport()).toBeUndefined();
  });

  it.each(['10s', '1e4', '-1', '60000.5'])('refuses %s rather than reading it loosely', (raw) => {
    process.env['ATLAS_S3_IDLE_TIMEOUT_MS'] = raw;

    expect(() => read_env_s3_transport()).toThrow('ATLAS_S3_IDLE_TIMEOUT_MS must be');
  });
});

describe('S3 transport settings in load_config', () => {
  const SETTINGS = {
    tenant_id: 'tid-prod',
    client_id: 'cid-prod',
    client_secret: 'secret-prod',
    s3_endpoint: 'http://localhost:9000',
    s3_access_key: 'access',
    s3_secret_key: 'secret-key',
    encryption_passphrase: 'passphrase',
  };

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue('/home/testuser');
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p).includes('atlas.config.json') && !String(p).includes('.atlas'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SETTINGS));
  });

  it('adds nothing when no variable is set', () => {
    expect(load_config()).not.toHaveProperty('s3_transport');
  });

  it('attaches the settings from the environment', () => {
    process.env['ATLAS_S3_IDLE_TIMEOUT_MS'] = '120000';

    expect(load_config().s3_transport).toEqual({
      ...DEFAULT_S3_TRANSPORT,
      idle_timeout_ms: 120_000,
    });
  });
});
