import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { register_config_command } from '@/commands/config.command';

vi.mock('dotenv', () => ({ config: vi.fn() }));

const fs_mocks = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('node:fs', () => fs_mocks);

const azure_mocks = vi.hoisted(() => ({ get_token: vi.fn() }));
// A `function`, not `vi.fn(() => ...)`: the credential is constructed with
// `new`, and an arrow mock fails with "is not a constructor", which surfaces as
// a failed Graph probe rather than as a broken test.
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

const COMPLETE_GRAPH = {
  tenant_id: '00000000-0000-0000-0000-000000000001',
  client_id: '00000000-0000-0000-0000-000000000002',
  client_secret: 'FAKE-client-secret',
};
const COMPLETE_S3 = {
  s3_endpoint: 'https://s3.example.invalid',
  s3_access_key: 'FAKEACCESSKEYID12345',
  s3_secret_key: 'FAKE-s3-secret-key',
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

    await run(['client.secret', '-']);

    // Read from fd 0, not from the argument vector.
    expect(fs_mocks.readFileSync).toHaveBeenCalledWith(0, 'utf-8');
    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      client_secret: 'FAKE-secret-from-stdin',
    });
  });

  it('rejects an invalid value and writes nothing', async () => {
    await expect(run(['tenant.id', 'not-a-guid'])).rejects.toThrow(/Invalid value for tenant.id/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('rejects a passphrase below the minimum length', async () => {
    await expect(run(['encryption.passphrase', 'short'])).rejects.toThrow(/at least 12/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('keeps existing keys when storing a new one', async () => {
    mocks.read_secure_config.mockReturnValue({ tenant_id: 'existing-tenant' });

    await run(['s3.region', 'eu-north-1']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      tenant_id: 'existing-tenant',
      s3_region: 'eu-north-1',
    });
  });

  it('warns that an ATLAS_* variable overrides the value just stored', async () => {
    mocks.read_env_overrides.mockReturnValue({ s3_region: 'us-west-2' });

    await run(['s3.region', 'eu-north-1']);

    expect(output.join('\n')).toMatch(/environment variable currently overrides s3\.region/);
  });

  it('does not warn when the environment agrees with the stored value', async () => {
    mocks.read_env_overrides.mockReturnValue({ s3_region: 'eu-north-1' });

    await run(['s3.region', 'eu-north-1']);

    expect(output.join('\n')).not.toMatch(/environment variable currently overrides/);
  });

  it('skips the live probe while the credential group is incomplete', async () => {
    await run(['client.id', '00000000-0000-0000-0000-000000000002']);

    expect(output.join('\n')).toMatch(/Graph credentials incomplete/);
    expect(azure_mocks.get_token).not.toHaveBeenCalled();
  });

  it('probes Graph once the last credential in the group is stored', async () => {
    mocks.read_secure_config.mockReturnValue(COMPLETE_GRAPH);

    await run(['client.secret', 'FAKE-client-secret']);

    expect(azure_mocks.get_token).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown key', async () => {
    await expect(run(['nope.key', 'value'])).rejects.toThrow(/Unknown config key "nope.key"/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });
});

describe('atlas config get', () => {
  it('warns and prints nothing when the key is unset', async () => {
    await run(['tenant.id']);

    expect(output.join('\n')).toMatch(/tenant\.id is not set/);
    expect(console.log).not.toHaveBeenCalled();
  });
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
});

describe('atlas config unset', () => {
  it('errors with usage when no key is given', async () => {
    await expect(run(['unset'])).rejects.toThrow(/Usage: atlas config unset/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('errors on an unknown key without mutating the store', async () => {
    await expect(run(['unset', 'nope.key'])).rejects.toThrow(/Unknown config key/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('warns and writes nothing when the key is not in the store', async () => {
    await run(['unset', 'tenant.id']);

    expect(output.join('\n')).toMatch(/not set in the secure store/);
    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('removes only the named key', async () => {
    mocks.read_secure_config.mockReturnValue({
      tenant_id: 'keep-me',
      client_secret: 'FAKE-remove-me',
    });

    await run(['unset', 'client.secret']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith({ tenant_id: 'keep-me' });
  });
});

describe('atlas config validate', () => {
  it('leaves the exit code clean when both probes pass', async () => {
    mocks.read_secure_config.mockReturnValue({ ...COMPLETE_GRAPH, ...COMPLETE_S3 });

    await run(['validate']);

    expect(process.exitCode).toBeUndefined();
  });

  it('exits non-zero when the Graph probe fails', async () => {
    mocks.read_secure_config.mockReturnValue({ ...COMPLETE_GRAPH, ...COMPLETE_S3 });
    azure_mocks.get_token.mockRejectedValue(new Error('AADSTS7000215'));

    await run(['validate']);

    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toMatch(/Graph validation failed/);
  });

  it('exits non-zero when the S3 probe fails, and still releases the client', async () => {
    mocks.read_secure_config.mockReturnValue({ ...COMPLETE_GRAPH, ...COMPLETE_S3 });
    s3_mocks.send.mockRejectedValue(new Error('InvalidAccessKeyId'));

    await run(['validate']);

    expect(process.exitCode).toBe(1);
    expect(s3_mocks.destroy).toHaveBeenCalled();
  });

  it('exits non-zero when credentials are missing entirely', async () => {
    await run(['validate']);

    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toMatch(/Graph credentials incomplete/);
    expect(output.join('\n')).toMatch(/S3 settings incomplete/);
  });
});
