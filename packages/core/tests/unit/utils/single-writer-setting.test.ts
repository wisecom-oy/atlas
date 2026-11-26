/** Issue #974: `ATLAS_SINGLE_WRITER` is an explicit opt-in, and a value it does not know is refused. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import { read_env_writer_exclusion } from '@/utils/single-writer-setting';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('read_env_writer_exclusion', () => {
  it('keeps the storage lease when the variable is unset', () => {
    vi.stubEnv('ATLAS_SINGLE_WRITER', undefined);
    expect(read_env_writer_exclusion()).toBe('storage_lease');
  });

  it.each(['', '0', 'false', 'FALSE'])('keeps the storage lease for %j', (value) => {
    vi.stubEnv('ATLAS_SINGLE_WRITER', value);
    expect(read_env_writer_exclusion()).toBe('storage_lease');
  });

  it.each(['1', 'true', 'True', ' 1 '])('selects single-writer mode for %j', (value) => {
    vi.stubEnv('ATLAS_SINGLE_WRITER', value);
    expect(read_env_writer_exclusion()).toBe('single_writer');
  });

  it.each(['yes', 'on', '2', 'single'])('refuses %j rather than guess', (value) => {
    vi.stubEnv('ATLAS_SINGLE_WRITER', value);
    expect(() => read_env_writer_exclusion()).toThrow(ConfigError);
  });
});
