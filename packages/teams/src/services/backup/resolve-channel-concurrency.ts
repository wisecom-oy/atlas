import { ConfigError } from '@wisecom/atlas-types';

/** Channels backed up at once when the caller leaves `concurrency` unset. */
export const DEFAULT_CHANNEL_CONCURRENCY = 4;
const MAX_CHANNEL_CONCURRENCY = 16;

/** The channel concurrency to use: the default when unset, else an integer from 1 to 16. */
export function resolve_channel_concurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CHANNEL_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHANNEL_CONCURRENCY) {
    throw new ConfigError(
      `Teams backup concurrency must be an integer from 1 to ${MAX_CHANNEL_CONCURRENCY}, ` +
        `got ${value}`,
    );
  }
  return value;
}
