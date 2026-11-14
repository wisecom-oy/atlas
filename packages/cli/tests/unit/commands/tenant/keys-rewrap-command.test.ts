import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { TenantRewrapOutcome, TenantSetRewrapRequest } from '@wisecom/atlas-types';
import { ConfigError, TENANT_SET_REWRAP_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { register_keys_command } from '@/commands/tenant/keys.command';

/**
 * Issue #716: `keys rewrap` covers every profile sharing the passphrase, refuses to strand one,
 * and switches the configured passphrase only after every key is re-wrapped.
 */

const OLD = 'FAKE-old-passphrase-for-tests';
const NEW = 'FAKE-new-passphrase-for-tests';

const mocks = vi.hoisted(() => ({
  read_secure_config: vi.fn(),
  update_secure_config: vi.fn(),
  try_load_config_file: vi.fn(),
  find_config_file: vi.fn(),
  prompt_key_passphrases: vi.fn(),
  rewrap_tenant_set: vi.fn(),
}));
vi.mock('@wisecom/atlas-core', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  read_secure_config: mocks.read_secure_config,
  update_secure_config: mocks.update_secure_config,
  try_load_config_file: mocks.try_load_config_file,
  find_config_file: mocks.find_config_file,
}));
vi.mock('@/utils/passphrase-prompt', () => ({
  prompt_key_passphrases: mocks.prompt_key_passphrases,
}));

let store: Record<string, unknown>;
let output: string[];

function run(args: string[]): Promise<unknown> {
  const container = new Container();
  container
    .bind(ATLAS_CONFIG_TOKEN)
    .toConstantValue({ tenant_id: 'a', encryption_passphrase: OLD });
  container
    .bind(TENANT_SET_REWRAP_USE_CASE_TOKEN)
    .toConstantValue({ rewrap_tenant_set: mocks.rewrap_tenant_set });
  const program = new Command();
  program.exitOverride();
  register_keys_command(program, () => container);
  return program.parseAsync(['keys', 'rewrap', ...args], { from: 'user' });
}

/** The use case reports each requested tenant as given, `rewrapped` by default. */
function outcomes_by_tenant(overrides: Record<string, TenantRewrapOutcome['status']> = {}): void {
  mocks.rewrap_tenant_set.mockImplementation(async (request: TenantSetRewrapRequest) => {
    const outcomes = request.tenant_ids.map((tenant_id) => {
      const status = overrides[tenant_id] ?? 'rewrapped';
      if (status === 'rewrapped') return { tenant_id, status, previous_kdf_id: 1, kdf_id: 1 };
      if (status === 'busy' || status === 'failed') return { tenant_id, status, detail: 'x' };
      return { tenant_id, status };
    });
    const complete = outcomes.every((o) =>
      ['rewrapped', 'already_rewrapped', 'no_key'].includes(o.status),
    );
    const passphrase_changed = request.current_passphrase !== request.next_passphrase;
    return { outcomes, complete, passphrase_changed };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  output = [];
  const capture = (...parts: unknown[]): void => void output.push(parts.map(String).join(' '));
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  store = {
    encryption_passphrase: OLD,
    tenants: { work: { tenant_id: 'a' }, home: { tenant_id: 'b' } },
  };
  mocks.read_secure_config.mockImplementation(() => store);
  mocks.update_secure_config.mockImplementation(
    (mutate: (s: object) => Record<string, unknown>) => {
      store = mutate(store);
      return store;
    },
  );
  mocks.try_load_config_file.mockReturnValue({});
  mocks.prompt_key_passphrases.mockResolvedValue({ new: NEW });
  vi.stubEnv('ATLAS_ENCRYPTION_PASSPHRASE', '');
  outcomes_by_tenant();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('atlas keys rewrap --new-passphrase', () => {
  it('re-wraps every profile tenant and then stores the new passphrase', async () => {
    await run(['--new-passphrase']);

    expect(mocks.rewrap_tenant_set).toHaveBeenCalledWith({
      tenant_ids: ['a', 'b'],
      current_passphrase: OLD,
      next_passphrase: NEW,
    });
    expect(store['encryption_passphrase']).toBe(NEW);
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 2 and leaves the configuration alone when one tenant is left', async () => {
    outcomes_by_tenant({ b: 'busy' });

    await run(['--new-passphrase']);

    expect(process.exitCode).toBe(2);
    expect(mocks.update_secure_config).not.toHaveBeenCalled();
    expect(store['encryption_passphrase']).toBe(OLD);
    expect(output.join('\n')).toMatch(/old passphrase.*: b\./);
  });

  it('writes nothing when the passphrase comes from the environment, and says where to change it', async () => {
    vi.stubEnv('ATLAS_ENCRYPTION_PASSPHRASE', OLD);

    await run(['--new-passphrase']);

    expect(mocks.update_secure_config).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('ATLAS_ENCRYPTION_PASSPHRASE');
  });

  it('writes nothing when the passphrase comes from the plain config file', async () => {
    store = { tenants: store['tenants'] };
    mocks.find_config_file.mockReturnValue('/srv/atlas/atlas.config.json');

    await run(['--new-passphrase']);

    expect(mocks.update_secure_config).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('/srv/atlas/atlas.config.json');
  });
});

describe('atlas keys rewrap --tenant', () => {
  it('refuses a passphrase change of one tenant and names the others, before any prompt', async () => {
    const err = await run(['--new-passphrase', '--tenant', 'a']).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain('would stay wrapped under the old one: b.');
    expect(mocks.prompt_key_passphrases).not.toHaveBeenCalled();
    expect(mocks.rewrap_tenant_set).not.toHaveBeenCalled();
  });

  it('with --allow-partial re-wraps the one tenant, exits 2 and keeps the configuration', async () => {
    await run(['--new-passphrase', '--tenant', 'a', '--allow-partial']);

    expect(mocks.rewrap_tenant_set).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_ids: ['a'] }),
    );
    expect(process.exitCode).toBe(2);
    expect(mocks.update_secure_config).not.toHaveBeenCalled();
  });

  it('allows a KDF-only refresh of one tenant without --allow-partial', async () => {
    mocks.prompt_key_passphrases.mockResolvedValue({});

    await run(['--tenant', 'a']);

    expect(mocks.rewrap_tenant_set).toHaveBeenCalledWith({
      tenant_ids: ['a'],
      current_passphrase: OLD,
      next_passphrase: OLD,
    });
    expect(process.exitCode).toBeUndefined();
  });
});

describe('atlas keys rewrap --old-passphrase', () => {
  it('finishes a rotation whose configured passphrase already changed, without writing config', async () => {
    mocks.prompt_key_passphrases.mockResolvedValue({ old: NEW });

    await run(['--old-passphrase']);

    // Config holds OLD here; the typed one is what the keys are still wrapped under.
    expect(mocks.rewrap_tenant_set).toHaveBeenCalledWith(
      expect.objectContaining({ current_passphrase: NEW, next_passphrase: OLD }),
    );
    expect(mocks.update_secure_config).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('treats the same value typed as old and new as retiring the configured passphrase', async () => {
    // The pair is equal, so the use case reports no change, yet the configured OLD would be
    // overwritten while the left-out tenant b is still wrapped under it.
    mocks.prompt_key_passphrases.mockResolvedValue({ old: NEW, new: NEW });

    await run(['--old-passphrase', '--new-passphrase', '--tenant', 'a', '--allow-partial']);

    expect(process.exitCode).toBe(2);
    expect(mocks.update_secure_config).not.toHaveBeenCalled();
    expect(store['encryption_passphrase']).toBe(OLD);
    expect(output.join('\n')).toMatch(/old passphrase.*: b\./);
  });
});
