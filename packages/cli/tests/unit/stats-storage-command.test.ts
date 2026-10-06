import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { STORAGE_USAGE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { register_stats_command } from '@/commands/stats.command';

const TOKEN = 'eyJ2ZXJzaW9uIjoxfQ';

function program_with(measure: Mock): Command {
  const container = new Container();
  container
    .bind(ATLAS_CONFIG_TOKEN)
    .toConstantValue({ tenant_id: 'tenant-1', encryption_passphrase: 'x' });
  container.bind(STORAGE_USAGE_USE_CASE_TOKEN).toConstantValue({ measure_storage_usage: measure });
  const program = new Command().exitOverride();
  register_stats_command(program, () => container);
  return program;
}

const run = (program: Command, ...args: string[]): Promise<Command> =>
  program.parseAsync(['node', 'atlas', 'stats', ...args]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('atlas stats storage', () => {
  it.each([
    ['--target-access-key', 'key'],
    ['--target-secret-key', 'secret'],
    ['--target-region', 'eu-west-1'],
  ])(
    'refuses %s without a replica endpoint instead of measuring primary storage',
    async (flag, value) => {
      const measure = vi.fn();

      await expect(run(program_with(measure), 'storage', flag, value)).rejects.toThrow(
        /Target credentials required/,
      );
      expect(measure).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid --top before listing anything', async () => {
    const measure = vi.fn();

    await expect(run(program_with(measure), '--top', '0', 'storage')).rejects.toThrow(
      '--top must be a positive integer',
    );
    expect(measure).not.toHaveBeenCalled();
  });

  it('prints the resume token when a measurement fails, then rethrows', async () => {
    const failure = Object.defineProperty(new Error('Service Unavailable'), 'continuation_token', {
      value: TOKEN,
      enumerable: false,
    });
    const measure = vi.fn().mockRejectedValue(failure);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(run(program_with(measure), 'storage', '--json')).rejects.toBe(failure);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`--continue ${TOKEN}`));
  });
});
