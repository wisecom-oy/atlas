import { describe, expect, it } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import {
  DEFAULT_CHANNEL_CONCURRENCY,
  resolve_channel_concurrency,
} from '@/services/backup/resolve-channel-concurrency';

describe('resolve_channel_concurrency', () => {
  it('uses the default when the caller leaves concurrency unset', () => {
    expect(resolve_channel_concurrency(undefined)).toBe(DEFAULT_CHANNEL_CONCURRENCY);
  });

  it('accepts the whole range from 1 to 16', () => {
    expect(resolve_channel_concurrency(1)).toBe(1);
    expect(resolve_channel_concurrency(16)).toBe(16);
  });

  it.each([0, -1, 17, 1.5, Number.NaN])('rejects %s with a config error', (value) => {
    expect(() => resolve_channel_concurrency(value)).toThrow(ConfigError);
    expect(() => resolve_channel_concurrency(value)).toThrow('from 1 to 16');
  });
});
