import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { OLD_WRAPPER_PURGE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { register_keys_command } from '@/commands/tenant/keys.command';

/** Issue #716: `keys purge-old-wrappers` asks first and exits 2 while an old wrapper is left. */

const mocks = vi.hoisted(() => ({
  read_secure_config: vi.fn(),
  try_load_config_file: vi.fn(),
  prompt_key_passphrases: vi.fn(),
  ask_confirmation: vi.fn(),
  purge_old_wrappers: vi.fn(),
}));
vi.mock('@wisecom/atlas-core', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  read_secure_config: mocks.read_secure_config,
  try_load_config_file: mocks.try_load_config_file,
}));
vi.mock('@/utils/passphrase-prompt', () => ({
  prompt_key_passphrases: mocks.prompt_key_passphrases,
}));
vi.mock('@/ui/components/confirm-prompt', () => ({ ask_confirmation: mocks.ask_confirmation }));

function run(args: string[]): Promise<unknown> {
  const container = new Container();
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'a' });
  container
    .bind(OLD_WRAPPER_PURGE_USE_CASE_TOKEN)
    .toConstantValue({ purge_old_wrappers: mocks.purge_old_wrappers });
  const program = new Command();
  program.exitOverride();
  register_keys_command(program, () => container);
  return program.parseAsync(['keys', 'purge-old-wrappers', ...args], { from: 'user' });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
  mocks.read_secure_config.mockReturnValue({ tenants: { work: { tenant_id: 'a' } } });
  mocks.try_load_config_file.mockReturnValue({});
  mocks.prompt_key_passphrases.mockResolvedValue({});
  mocks.purge_old_wrappers.mockResolvedValue({
    outcomes: [{ tenant_id: 'a', status: 'purged', versions: [] }],
    complete: true,
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('atlas keys purge-old-wrappers', () => {
  it('deletes nothing when the confirmation is declined', async () => {
    mocks.ask_confirmation.mockResolvedValue(false);

    await run([]);

    expect(mocks.purge_old_wrappers).not.toHaveBeenCalled();
  });

  it('skips the question with -y and passes the typed old passphrase on', async () => {
    mocks.prompt_key_passphrases.mockResolvedValue({ old: 'FAKE-old-passphrase-for-tests' });

    await run(['-y', '--old-passphrase']);

    expect(mocks.ask_confirmation).not.toHaveBeenCalled();
    expect(mocks.purge_old_wrappers).toHaveBeenCalledWith({
      tenant_ids: ['a'],
      previous_passphrases: ['FAKE-old-passphrase-for-tests'],
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 2 when a version is retained', async () => {
    mocks.purge_old_wrappers.mockResolvedValue({
      outcomes: [
        {
          tenant_id: 'a',
          status: 'versions_left',
          versions: [{ version_id: 'v1', status: 'retained' }],
        },
      ],
      complete: false,
    });

    await run(['-y']);

    expect(process.exitCode).toBe(2);
  });
});
