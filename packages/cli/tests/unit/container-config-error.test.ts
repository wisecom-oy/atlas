import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import { compose_container } from '@/container';
import { handle_fatal_error } from '@/fatal-error';

const load_config = vi.hoisted(() => vi.fn());

vi.mock('@wisecom/atlas-core', async (import_original) => ({
  ...(await import_original<typeof import('@wisecom/atlas-core')>()),
  load_config,
}));

describe('compose_container with a refused configuration', () => {
  let previous_exit_code: typeof process.exitCode;

  beforeEach(() => {
    previous_exit_code = process.exitCode;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = previous_exit_code;
    vi.restoreAllMocks();
  });

  it('turns a partial Graph override into a ConfigError that exits 6', () => {
    load_config.mockImplementation(() => {
      throw new Error('Environment variables change tenant profile "prod" (ATLAS_TENANT_ID)');
    });

    let thrown: unknown;
    try {
      compose_container({ profile: 'prod' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);

    handle_fatal_error(thrown);
    expect(process.exitCode).toBe(6);
  });
});
