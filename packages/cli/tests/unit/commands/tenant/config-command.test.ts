import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { register_config_command } from '@/commands/tenant/config.command';

vi.mock('dotenv', () => ({ config: vi.fn() }));

const fs_mocks = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('node:fs', () => fs_mocks);

// Config no longer probes Graph; the mock exists so a regression that does is caught.
const azure_mocks = vi.hoisted(() => ({ get_token: vi.fn() }));
// A `function`, not `vi.fn(() => ...)`: the credential is constructed with
// `new`, and an arrow mock fails with "is not a constructor", which surfaces as
// a failed probe rather than as a broken test.
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: function () {
    return { getToken: azure_mocks.get_token };
  },
}));

const s3_mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock('@wisecom/atlas-s3', () => ({
  create_s3_client: vi.fn(() => ({ send: s3_mocks.send, destroy: s3_mocks.destroy })),
}));
vi.mock('@aws-sdk/client-s3', () => ({ ListBucketsCommand: vi.fn() }));

const mocks = vi.hoisted(() => ({
  read_secure_config: vi.fn(),
  write_secure_config: vi.fn(),
  read_env_overrides: vi.fn(),
  try_load_config_file: vi.fn(),
  secure_config_dir: vi.fn(() => '/tmp/fake-atlas'),
}));
vi.mock('@wisecom/atlas-core', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, ...mocks };
});

const COMPLETE_S3 = {
  s3_endpoint: 'https://s3.example.invalid',
  s3_access_key: 'FAKEACCESSKEYID12345',
  s3_secret_key: 'FAKE-s3-secret-key',
};

/** A store already holding a tenant profile, so the shape of the layout is exercised. */
const STORE_WITH_PROFILE = {
  tenants: {
    default: {
      tenant_id: '00000000-0000-0000-0000-000000000001',
      client_id: '00000000-0000-0000-0000-000000000002',
      client_secret: 'FAKE-client-secret',
    },
  },
  active_tenant: 'default',
};

let output: string[];

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  register_config_command(program);
  return program.parseAsync(['config', ...args], { from: 'user' });
}

beforeEach(() => {
  // restoreAllMocks only restores spies; the hoisted module mocks keep their
  // call history between tests without this.
  vi.clearAllMocks();
  output = [];
  const capture = (...parts: unknown[]): void => {
    output.push(parts.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);

  mocks.try_load_config_file.mockReturnValue({});
  mocks.read_env_overrides.mockReturnValue({});
  mocks.read_secure_config.mockReturnValue({});
  azure_mocks.get_token.mockResolvedValue({ token: 'fake' });
  s3_mocks.send.mockResolvedValue({ Buckets: [] });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('atlas config set', () => {
  it('reads the value from stdin when given "-", keeping it out of shell history', async () => {
    fs_mocks.readFileSync.mockReturnValue('  FAKE-secret-from-stdin  \n');

    await run(['set', 's3.secret-key', '-']);

    // Read from fd 0, not from the argument vector.
    expect(fs_mocks.readFileSync).toHaveBeenCalledWith(0, 'utf-8');
    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      s3_secret_key: 'FAKE-secret-from-stdin',
    });
  });

  it('rejects an invalid value and writes nothing', async () => {
    await expect(run(['set', 's3.endpoint', 'not a url'])).rejects.toThrow(
      /Invalid value for s3.endpoint/,
    );

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('rejects a passphrase below the minimum length', async () => {
    await expect(run(['set', 'encryption.passphrase', 'thirteen-byte'])).rejects.toThrow(
      /at least 14 UTF-8 bytes/,
    );

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('keeps existing keys, tenant profiles included, when storing a new one', async () => {
    mocks.read_secure_config.mockReturnValue(STORE_WITH_PROFILE);

    await run(['set', 's3.region', 'eu-north-1']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      ...STORE_WITH_PROFILE,
      s3_region: 'eu-north-1',
    });
  });

  it('warns that an ATLAS_* variable overrides the value just stored', async () => {
    mocks.read_env_overrides.mockReturnValue({ s3_region: 'us-west-2' });

    await run(['set', 's3.region', 'eu-north-1']);

    expect(output.join('\n')).toMatch(/environment variable currently overrides s3\.region/);
  });

  it('does not warn when the environment agrees with the stored value', async () => {
    mocks.read_env_overrides.mockReturnValue({ s3_region: 'eu-north-1' });

    await run(['set', 's3.region', 'eu-north-1']);

    expect(output.join('\n')).not.toMatch(/environment variable currently overrides/);
  });

  it('skips the live probe while the S3 group is incomplete', async () => {
    await run(['set', 's3.endpoint', 'https://s3.example.invalid']);

    expect(output.join('\n')).toMatch(/S3 settings incomplete/);
    expect(s3_mocks.send).not.toHaveBeenCalled();
  });

  it('probes S3 once the last S3 field is stored', async () => {
    mocks.read_secure_config.mockReturnValue(COMPLETE_S3);

    await run(['set', 's3.secret-key', 'FAKE-s3-secret-key']);

    expect(s3_mocks.send).toHaveBeenCalledTimes(1);
    expect(azure_mocks.get_token).not.toHaveBeenCalled();
  });

  it('rejects an unknown key', async () => {
    await expect(run(['set', 'nope.key', 'value'])).rejects.toThrow(
      /Unknown config key "nope.key"/,
    );

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it.each(['tenant.id', 'client.id', 'client.secret'])(
    'points %s at atlas tenants instead of storing it',
    async (key) => {
      await expect(run(['set', key, 'FAKE-value'])).rejects.toThrow(
        /Tenant credentials now live in tenant profiles/,
      );

      expect(mocks.write_secure_config).not.toHaveBeenCalled();
    },
  );
});

describe('atlas config get', () => {
  it('warns and prints nothing when the key is unset', async () => {
    await run(['get', 's3.region']);

    expect(output.join('\n')).toMatch(/s3\.region is not set/);
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each(['tenant.id', 'client.id', 'client.secret'])(
    'points %s at atlas tenants instead of reading it',
    async (key) => {
      await expect(run(['get', key])).rejects.toThrow(
        /Tenant credentials now live in tenant profiles/,
      );
    },
  );
});

describe('atlas config list', () => {
  it('marks unset keys rather than omitting them', async () => {
    await run(['list']);

    expect(output.join('\n')).toContain('<unset>');
  });

  it('names the source a value resolves from, environment winning', async () => {
    mocks.try_load_config_file.mockReturnValue({ s3_region: 'from-file' });
    mocks.read_secure_config.mockReturnValue({ s3_region: 'from-store' });
    mocks.read_env_overrides.mockReturnValue({ s3_region: 'from-env' });

    await run(['list']);

    const line = output.find((l) => l.includes('s3.region'));
    expect(line).toContain('from-env');
    expect(line).toContain('(env)');
  });

  it('reports the secure store as the source when no variable overrides it', async () => {
    mocks.read_secure_config.mockReturnValue({ s3_region: 'from-store' });

    await run(['list']);

    expect(output.find((l) => l.includes('s3.region'))).toContain('(secure store)');
  });

  it('lists only shared keys; tenant credentials are not listed here', async () => {
    await run(['list']);

    expect(output.join('\n')).not.toContain('tenant.id');
    expect(output.join('\n')).not.toContain('client.secret');
  });
});

describe('atlas config unset', () => {
  it('refuses to run without a key rather than guessing one', async () => {
    await expect(run(['unset'])).rejects.toThrow(/missing required argument/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('errors on an unknown key without mutating the store', async () => {
    await expect(run(['unset', 'nope.key'])).rejects.toThrow(/Unknown config key/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('warns and writes nothing when the key is not in the store', async () => {
    await run(['unset', 's3.region']);

    expect(output.join('\n')).toMatch(/not set in the secure store/);
    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('removes only the named key and keeps tenant profiles', async () => {
    mocks.read_secure_config.mockReturnValue({ ...STORE_WITH_PROFILE, s3_region: 'eu-north-1' });

    await run(['unset', 's3.region']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith(STORE_WITH_PROFILE);
  });

  it.each(['tenant.id', 'client.id', 'client.secret'])(
    'points %s at atlas tenants instead of removing it',
    async (key) => {
      await expect(run(['unset', key])).rejects.toThrow(
        /Tenant credentials now live in tenant profiles/,
      );

      expect(mocks.write_secure_config).not.toHaveBeenCalled();
    },
  );
});

describe('atlas config validate', () => {
  it('leaves the exit code clean when the S3 probe passes, and never touches Graph', async () => {
    mocks.read_secure_config.mockReturnValue(COMPLETE_S3);

    await run(['validate']);

    expect(process.exitCode).toBeUndefined();
    expect(s3_mocks.send).toHaveBeenCalledTimes(1);
    expect(azure_mocks.get_token).not.toHaveBeenCalled();
  });

  it('exits non-zero when the S3 probe fails, and still releases the client', async () => {
    mocks.read_secure_config.mockReturnValue(COMPLETE_S3);
    s3_mocks.send.mockRejectedValue(new Error('InvalidAccessKeyId'));

    await run(['validate']);

    expect(process.exitCode).toBe(1);
    expect(s3_mocks.destroy).toHaveBeenCalled();
  });

  it('exits non-zero when S3 settings are missing, and points Graph checks elsewhere', async () => {
    await run(['validate']);

    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toMatch(/S3 settings incomplete/);
    expect(output.join('\n')).not.toMatch(/Graph/);
  });
});
