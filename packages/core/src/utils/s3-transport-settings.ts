import { ConfigError } from '@wisecom/atlas-types';

/**
 * How long the S3 client waits on a backend before it gives up, and how often it tries
 * (issue #924). Without these bounds a backend that accepts a connection and never answers held a
 * run, and the owner lease it renews, forever.
 */
export interface S3TransportSettings {
  /** Milliseconds for the TCP connection to open. 0 disables the timeout. */
  readonly connection_timeout_ms: number;
  /**
   * Milliseconds a request's socket may stay silent, nothing sent and nothing received, before the
   * request is cut off. Measured per socket read and write, never across the whole request, so a
   * slow transfer that keeps moving bytes never reaches it. 0 disables the timeout.
   */
  readonly idle_timeout_ms: number;
  /** Attempts per request, the first one included. */
  readonly max_attempts: number;
}

export type S3TransportField = keyof S3TransportSettings;

/** Each setting before validation: a number from the SDK, or a parsed environment variable. */
export type S3TransportOverrides = Partial<Record<S3TransportField, unknown>>;

/**
 * The defaults. The idle timeout allows a 5 GiB server-side copy at 17 MB/s on a backend that sends
 * nothing until the copy ends; a slow link that keeps moving bytes is never cut off by it.
 */
export const DEFAULT_S3_TRANSPORT: S3TransportSettings = {
  connection_timeout_ms: 10_000,
  idle_timeout_ms: 300_000,
  max_attempts: 3,
};

/** Environment variable for each setting, as `load_config` reads them. */
export const S3_TRANSPORT_ENV_VARS: Readonly<Record<S3TransportField, string>> = {
  connection_timeout_ms: 'ATLAS_S3_CONNECTION_TIMEOUT_MS',
  idle_timeout_ms: 'ATLAS_S3_IDLE_TIMEOUT_MS',
  max_attempts: 'ATLAS_S3_MAX_ATTEMPTS',
};

interface SettingRange {
  readonly min: number;
  readonly max: number;
  /** True when 0 is accepted below `min`, meaning "no timeout". */
  readonly zero_disables: boolean;
}

const RANGES: Readonly<Record<S3TransportField, SettingRange>> = {
  connection_timeout_ms: { min: 1_000, max: 600_000, zero_disables: true },
  idle_timeout_ms: { min: 1_000, max: 3_600_000, zero_disables: true },
  max_attempts: { min: 1, max: 10, zero_disables: false },
};

const FIELDS = Object.keys(RANGES) as S3TransportField[];

/**
 * Applies `overrides` over the defaults, or returns undefined when nothing is overridden. Throws
 * `ConfigError` naming the setting, through `setting_names`, when a value is not an integer in its
 * range.
 */
export function build_s3_transport(
  overrides: S3TransportOverrides,
  setting_names: Readonly<Record<S3TransportField, string>>,
): S3TransportSettings | undefined {
  const given = FIELDS.filter((field) => overrides[field] !== undefined);
  if (given.length === 0) return undefined;
  const settings: Record<S3TransportField, number> = { ...DEFAULT_S3_TRANSPORT };
  for (const field of given) {
    settings[field] = validated_setting(overrides[field], RANGES[field], setting_names[field]);
  }
  return settings;
}

/** The transport settings from the `ATLAS_S3_*` variables, or undefined when none is set. */
export function read_env_s3_transport(): S3TransportSettings | undefined {
  const overrides: S3TransportOverrides = {};
  for (const field of FIELDS) {
    const raw = process.env[S3_TRANSPORT_ENV_VARS[field]];
    if (raw !== undefined && raw !== '') overrides[field] = parse_whole_number(raw);
  }
  return build_s3_transport(overrides, S3_TRANSPORT_ENV_VARS);
}

/** Digits only, so `10s`, `1e4` and `-1` are refused rather than read as something else. */
function parse_whole_number(raw: string): number {
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

function validated_setting(value: unknown, range: SettingRange, setting_name: string): number {
  const valid =
    typeof value === 'number' &&
    Number.isInteger(value) &&
    ((range.zero_disables && value === 0) || (value >= range.min && value <= range.max));
  if (valid) return value;
  const accepted = `an integer from ${range.min} to ${range.max}`;
  throw new ConfigError(
    `${setting_name} must be ${range.zero_disables ? `0 (no timeout) or ${accepted}` : accepted}.`,
  );
}
