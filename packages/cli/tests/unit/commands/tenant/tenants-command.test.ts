import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { register_tenants_command } from '@/commands/tenant/tenants.command';

const dotenv_mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('dotenv', () => ({ config: dotenv_mocks.config }));

const fs_mocks = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('node:fs', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  readFileSync: fs_mocks.readFileSync,
}));

const azure_mocks = vi.hoisted(() => ({ ctor: vi.fn(), get_token: vi.fn() }));
// A `function`, not `vi.fn(() => ...)`: the credential is constructed with `new`.
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: function (...args: unknown[]) {
    azure_mocks.ctor(...args);
    return { getToken: azure_mocks.get_token };
  },
}));

const mocks = vi.hoisted(() => {
  const read_secure_config = vi.fn();
  // Records what each locked update persisted; the store itself is never written.
  const write_secure_config = vi.fn();
  return {
    read_secure_config,
    write_secure_config,
    update_secure_config: vi.fn((mutate: (current: object) => object) => {
      const next = mutate(read_secure_config() ?? {});
      write_secure_config(next);
      return next;
    }),
    read_env_overrides: vi.fn(),
    try_load_config_file: vi.fn(),
    secure_config_dir: vi.fn(() => '/tmp/fake-atlas'),
  };
});
vi.mock('@wisecom/atlas-core', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  ...mocks,
}));

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const SECRET = 'FAKE-client-secret';
const WORK = { tenant_id: TENANT, client_id: CLIENT, client_secret: SECRET };

let output: string[];

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.option('--profile <name>');
  register_tenants_command(program);
  return program.parseAsync(['tenants', ...args], { from: 'user' });
}

function add_args(name: string, extra: string[] = []): string[] {
  return [
    'add',
    name,
    '--tenant-id',
    TENANT,
    '--client-id',
    CLIENT,
    '--client-secret',
    SECRET,
    ...extra,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  output = [];
  const capture = (...parts: unknown[]): void => {
    output.push(parts.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);

  mocks.try_load_config_file.mockReturnValue({});
  mocks.read_secure_config.mockReturnValue({});
  mocks.read_env_overrides.mockReturnValue({});
  azure_mocks.get_token.mockResolvedValue({ token: 'fake' });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('atlas tenants add', () => {
  it('saves the first profile and makes it the active one', async () => {
    await run(add_args('work'));

    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      tenants: { work: WORK },
      active_tenant: 'work',
    });
    expect(output.join('\n')).toMatch(/is the first profile/);
  });

  it('leaves the active profile alone when one is already set', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { other: WORK }, active_tenant: 'other' });

    await run(add_args('work'));

    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      tenants: { other: WORK, work: WORK },
      active_tenant: 'other',
    });
  });

  it('does not activate a profile when others exist but none is active', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { other: WORK } });

    await run(add_args('work'));

    const written = mocks.write_secure_config.mock.calls[0]![0];
    expect(written).not.toHaveProperty('active_tenant');
    expect(written.tenants).toHaveProperty('work');
  });

  it('refuses to overwrite an existing profile without --replace', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK }, active_tenant: 'work' });

    await expect(run(add_args('work'))).rejects.toThrow(/already exists/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('overwrites an existing profile with --replace', async () => {
    mocks.read_secure_config.mockReturnValue({
      tenants: { work: { ...WORK, client_secret: 'FAKE-old-secret' } },
      active_tenant: 'work',
    });

    await run(add_args('work', ['--replace']));

    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      tenants: { work: WORK },
      active_tenant: 'work',
    });
  });

  it('notes when the store copy now overrides a profile in atlas.config.json', async () => {
    mocks.try_load_config_file.mockReturnValue({ tenants: { work: WORK } });

    await run(add_args('work', ['--replace']));

    expect(output.join('\n')).toMatch(/overrides the one in atlas\.config\.json/);
  });

  it('rejects a profile name outside the allowed pattern', async () => {
    await expect(run(add_args('Work!'))).rejects.toThrow(/Invalid profile name "Work!"/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('rejects a malformed tenant ID and writes nothing', async () => {
    await expect(
      run([
        'add',
        'work',
        '--tenant-id',
        'not-a-guid',
        '--client-id',
        CLIENT,
        '--client-secret',
        SECRET,
      ]),
    ).rejects.toThrow(/Invalid --tenant-id/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('stores the tenant ID in lowercase, the only form a bucket name accepts', async () => {
    await run([
      'add',
      'work',
      '--tenant-id',
      'Contoso.OnMicrosoft.com',
      '--client-id',
      CLIENT,
      '--client-secret',
      SECRET,
    ]);

    expect(mocks.write_secure_config).toHaveBeenCalledWith(
      expect.objectContaining({
        tenants: { work: { ...WORK, tenant_id: 'contoso.onmicrosoft.com' } },
      }),
    );
  });

  it('reads the client secret from stdin when given "-"', async () => {
    fs_mocks.readFileSync.mockReturnValue('  FAKE-from-stdin \n');

    await run([
      'add',
      'work',
      '--tenant-id',
      TENANT,
      '--client-id',
      CLIENT,
      '--client-secret',
      '-',
    ]);

    expect(fs_mocks.readFileSync).toHaveBeenCalledWith(0, 'utf-8');
    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      tenants: { work: { ...WORK, client_secret: 'FAKE-from-stdin' } },
      active_tenant: 'work',
    });
  });

  it('fails on empty stdin rather than storing an empty secret', async () => {
    fs_mocks.readFileSync.mockReturnValue('\n');

    await expect(
      run(['add', 'work', '--tenant-id', TENANT, '--client-id', CLIENT, '--client-secret', '-']),
    ).rejects.toThrow(/stdin was empty/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('keeps the profile but exits non-zero when the Graph check fails', async () => {
    azure_mocks.get_token.mockRejectedValue(new Error('AADSTS7000215'));

    await run(add_args('work'));

    expect(mocks.write_secure_config).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toMatch(/Microsoft Graph \[work\] validation failed/);
    expect(output.join('\n')).toMatch(/saved despite the failed check/);
  });

  it('migrates legacy top-level Graph fields into tenants.default without keeping them', async () => {
    mocks.read_secure_config.mockReturnValue({
      tenant_id: TENANT,
      client_id: CLIENT,
      client_secret: SECRET,
      s3_region: 'eu-north-1',
    });

    await run(add_args('work'));

    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      s3_region: 'eu-north-1',
      tenants: { default: WORK, work: WORK },
    });
  });

  it('loads .env quietly before running', async () => {
    await run(add_args('work'));

    expect(dotenv_mocks.config).toHaveBeenCalledWith({ quiet: true });
  });
});
