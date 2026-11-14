import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { ConfigError } from '@wisecom/atlas-types';
import { register_tenants_command } from '@/commands/tenant/tenants.command';

const dotenv_mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('dotenv', () => ({ config: dotenv_mocks.config }));

const azure_mocks = vi.hoisted(() => ({
  created: [] as [string, string][],
  attempted: [] as string[],
  failing_tenants: new Set<string>(),
}));
// Records each credential's tenant and client, and fails the tenants listed in
// `failing_tenants`, so the test does not depend on the order profiles are probed in.
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: function (tenant_id: string, client_id: string) {
    azure_mocks.created.push([tenant_id, client_id]);
    return {
      getToken: vi.fn(async () => {
        azure_mocks.attempted.push(tenant_id);
        if (azure_mocks.failing_tenants.has(tenant_id)) {
          throw new Error('AADSTS700016');
        }
        return { token: 'fake' };
      }),
    };
  },
}));

const s3_mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock('@wisecom/atlas-s3', () => ({
  create_s3_client: vi.fn(() => ({ send: s3_mocks.send, destroy: s3_mocks.destroy })),
}));
vi.mock('@aws-sdk/client-s3', () => ({ ListBucketsCommand: vi.fn() }));

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
const OTHER_CLIENT = '00000000-0000-0000-0000-0000000000aa';
const SECRET = 'FAKE-client-secret';
const CONTOSO = 'contoso.onmicrosoft.com';
const WORK = { tenant_id: TENANT, client_id: CLIENT, client_secret: SECRET };
const HOME = { tenant_id: CONTOSO, client_id: CLIENT, client_secret: SECRET };
const S3 = {
  s3_endpoint: 'https://s3.example.invalid',
  s3_access_key: 'FAKE-access-key-id',
  s3_secret_key: 'FAKE-s3-secret-do-not-use-8Zk2',
  s3_region: 'us-east-1',
};

let output: string[];

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.option('--profile <name>');
  register_tenants_command(program);
  return program.parseAsync(['tenants', ...args], { from: 'user' });
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

  azure_mocks.created.length = 0;
  azure_mocks.attempted.length = 0;
  azure_mocks.failing_tenants.clear();
  s3_mocks.send.mockResolvedValue({ Buckets: [] });

  mocks.try_load_config_file.mockReturnValue({});
  mocks.read_secure_config.mockReturnValue({ ...S3 });
  mocks.read_env_overrides.mockReturnValue({});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('atlas tenants validate', () => {
  it('--all exits non-zero when one profile fails, and probes S3 once', async () => {
    mocks.read_secure_config.mockReturnValue({
      ...S3,
      tenants: { home: HOME, work: WORK },
      active_tenant: 'work',
    });
    azure_mocks.failing_tenants.add(CONTOSO);

    await run(['validate', '--all']);

    expect(azure_mocks.attempted.sort()).toEqual([CONTOSO, TENANT].sort());
    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toMatch(/Microsoft Graph \[home\] validation failed/);
    expect(output.join('\n')).toMatch(/Microsoft Graph \[work\]: token acquired/);
    expect(s3_mocks.send).toHaveBeenCalledTimes(1);
  });

  it('validates only the selected profile when no name is given', async () => {
    mocks.read_secure_config.mockReturnValue({
      ...S3,
      tenants: { home: HOME, work: WORK },
      active_tenant: 'work',
    });

    await run(['validate']);

    expect(azure_mocks.attempted).toEqual([TENANT]);
    expect(output.join('\n')).toContain('[work]');
    expect(output.join('\n')).not.toContain('[home]');
    expect(process.exitCode).toBeUndefined();
  });

  it('validates one named profile', async () => {
    mocks.read_secure_config.mockReturnValue({
      ...S3,
      tenants: { home: HOME, work: WORK },
      active_tenant: 'work',
    });

    await run(['validate', 'home']);

    expect(azure_mocks.attempted).toEqual([CONTOSO]);
  });

  it('rejects a profile name combined with --all', async () => {
    mocks.read_secure_config.mockReturnValue({ ...S3, tenants: { home: HOME } });

    await expect(run(['validate', 'home', '--all'])).rejects.toThrow(
      /either a profile name or --all/,
    );

    expect(azure_mocks.attempted).toEqual([]);
  });

  it('rejects an unknown profile name without probing anything', async () => {
    mocks.read_secure_config.mockReturnValue({ ...S3, tenants: { home: HOME } });

    await expect(run(['validate', 'nope'])).rejects.toThrow(/Unknown tenant profile/);

    expect(azure_mocks.attempted).toEqual([]);
  });

  it('rejects --all when no profiles exist', async () => {
    mocks.read_secure_config.mockReturnValue({ ...S3 });

    await expect(run(['validate', '--all'])).rejects.toThrow(/No tenant profiles to validate/);

    expect(azure_mocks.attempted).toEqual([]);
  });

  it('applies ATLAS_* Graph overrides only to the selected profile', async () => {
    mocks.read_secure_config.mockReturnValue({
      ...S3,
      tenants: { home: HOME, work: WORK },
      active_tenant: 'work',
    });
    mocks.read_env_overrides.mockReturnValue({ ...WORK, client_id: OTHER_CLIENT });

    await run(['validate', '--all']);

    expect(azure_mocks.created).toEqual([
      [CONTOSO, CLIENT],
      [TENANT, OTHER_CLIENT],
    ]);
    expect(output.join('\n')).toContain(
      'Environment variables override tenant profile "work" for this run: ATLAS_CLIENT_ID.',
    );
  });

  it('refuses a partial override that changes the selected identity before any probe', async () => {
    mocks.read_secure_config.mockReturnValue({
      ...S3,
      tenants: { work: WORK },
      active_tenant: 'work',
    });
    mocks.read_env_overrides.mockReturnValue({ tenant_id: CONTOSO });

    const failure = run(['validate']);

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toMatchObject({
      cause: { message: expect.stringContaining('would combine two identities') },
    });
    expect(azure_mocks.created).toEqual([]);
    expect(s3_mocks.send).not.toHaveBeenCalled();
  });

  it('leaves a named profile other than the selected one unchecked, as the variables skip it', async () => {
    mocks.read_secure_config.mockReturnValue({
      ...S3,
      tenants: { home: HOME, work: WORK },
      active_tenant: 'work',
    });
    mocks.read_env_overrides.mockReturnValue({ tenant_id: CONTOSO });

    await run(['validate', 'home']);

    expect(azure_mocks.attempted).toEqual([CONTOSO]);
    expect(process.exitCode).toBeUndefined();
  });

  it('validates env-only Graph credentials as the selected profile when no profiles are stored', async () => {
    mocks.read_env_overrides.mockReturnValue({
      tenant_id: TENANT,
      client_id: CLIENT,
      client_secret: SECRET,
    });

    await run(['validate', '--all']);

    expect(azure_mocks.attempted).toEqual([TENANT]);
    expect(output.join('\n')).toContain('Microsoft Graph [default]');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports missing env-only Graph fields instead of rejecting the selected profile', async () => {
    mocks.read_env_overrides.mockReturnValue({ client_id: CLIENT });

    await run(['validate']);

    expect(azure_mocks.attempted).toEqual([]);
    expect(output.join('\n')).toMatch(/Microsoft Graph \[default\]: credentials incomplete/);
    expect(process.exitCode).toBe(1);
  });

  it('still rejects a named profile that is neither stored nor selected by the environment', async () => {
    mocks.read_env_overrides.mockReturnValue({ client_id: CLIENT });

    await expect(run(['validate', 'nope'])).rejects.toThrow(/Unknown tenant profile/);

    expect(azure_mocks.attempted).toEqual([]);
  });
});
