import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { register_tenants_command } from '@/commands/tenant/tenants.command';

const dotenv_mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('dotenv', () => ({ config: dotenv_mocks.config }));

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
const HOME = { tenant_id: 'contoso.onmicrosoft.com', client_id: CLIENT, client_secret: SECRET };

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

  mocks.try_load_config_file.mockReturnValue({});
  mocks.read_secure_config.mockReturnValue({});
  mocks.read_env_overrides.mockReturnValue({});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('atlas tenants list', () => {
  it('says how to add a profile when none exist', async () => {
    await run(['list']);

    expect(output.join('\n')).toMatch(/No tenant profiles yet/);
  });

  it('masks secrets, marks the selected profile, and names where each is defined', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK }, active_tenant: 'work' });
    mocks.try_load_config_file.mockReturnValue({
      tenants: { home: { ...HOME, client_secret: 'FAKE-file-secret-9999' } },
    });

    await run(['list']);

    const text = output.join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('FAKE-file-secret-9999');
    expect(text).toContain('****cret');
    expect(output.find((line) => line.includes('* work'))).toContain('(secure store)');
    expect(output.find((line) => line.includes('  home'))).toContain('(config file)');
  });

  it('reports a profile defined in both places as both', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK }, active_tenant: 'work' });
    mocks.try_load_config_file.mockReturnValue({ tenants: { work: { client_id: CLIENT } } });

    await run(['list']);

    expect(output.find((line) => line.includes('* work'))).toContain('(both)');
  });

  it('warns when the selected profile is not defined anywhere', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK }, active_tenant: 'missing' });

    await run(['list']);

    expect(output.join('\n')).toMatch(/Unknown tenant profile/);
  });

  it('notes an ATLAS_PROFILE selection and warns about Graph env overrides', async () => {
    vi.stubEnv('ATLAS_PROFILE', 'work');
    vi.stubEnv('ATLAS_CLIENT_ID', CLIENT);
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK } });

    await run(['list']);

    const text = output.join('\n');
    expect(text).toMatch(/ATLAS_PROFILE selects "work"/);
    expect(text).toMatch(/ATLAS_CLIENT_ID override the selected profile/);
  });
});

describe('atlas tenants use', () => {
  it('rejects an unknown profile and writes nothing', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK } });

    await expect(run(['use', 'nope'])).rejects.toThrow(/Unknown tenant profile/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('stores the chosen profile as active and keeps the others', async () => {
    mocks.read_secure_config.mockReturnValue({
      tenants: { work: WORK, home: HOME },
      active_tenant: 'work',
    });

    await run(['use', 'home']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      tenants: { work: WORK, home: HOME },
      active_tenant: 'home',
    });
  });

  it('can select a profile defined only in atlas.config.json', async () => {
    mocks.try_load_config_file.mockReturnValue({ tenants: { legacy: WORK } });

    await run(['use', 'legacy']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith({ active_tenant: 'legacy' });
  });

  it('warns that ATLAS_PROFILE will override the stored choice', async () => {
    vi.stubEnv('ATLAS_PROFILE', 'work');
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK, home: HOME } });

    await run(['use', 'home']);

    expect(output.join('\n')).toMatch(/ATLAS_PROFILE is set to "work"/);
  });
});

describe('atlas tenants remove', () => {
  it('refuses to remove the active profile without --yes', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK }, active_tenant: 'work' });

    await expect(run(['remove', 'work'])).rejects.toThrow(/Pass --yes/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('removes the active profile with --yes and leaves no profile active', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { work: WORK }, active_tenant: 'work' });

    await run(['remove', 'work', '--yes']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith({});
    expect(output.join('\n')).toMatch(/No profile is active now/);
  });

  it('removes a non-active profile and keeps the active choice', async () => {
    mocks.read_secure_config.mockReturnValue({
      tenants: { work: WORK, home: HOME },
      active_tenant: 'work',
    });

    await run(['remove', 'home']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith({
      tenants: { work: WORK },
      active_tenant: 'work',
    });
  });

  it('refuses a profile that exists only in atlas.config.json', async () => {
    mocks.try_load_config_file.mockReturnValue({ tenants: { legacy: WORK } });

    await expect(run(['remove', 'legacy'])).rejects.toThrow(/defined in atlas\.config\.json/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('rejects an unknown profile', async () => {
    await expect(run(['remove', 'nope'])).rejects.toThrow(/Unknown tenant profile/);

    expect(mocks.write_secure_config).not.toHaveBeenCalled();
  });

  it('warns when the removed profile remains defined in atlas.config.json', async () => {
    mocks.read_secure_config.mockReturnValue({ tenants: { home: HOME } });
    mocks.try_load_config_file.mockReturnValue({ tenants: { home: HOME } });

    await run(['remove', 'home']);

    expect(mocks.write_secure_config).toHaveBeenCalledWith({});
    expect(output.join('\n')).toMatch(/still exists in atlas\.config\.json/);
  });
});
