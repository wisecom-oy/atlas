import { logger } from '@wisecom/atlas-core';
import { UnreadableObjectsError } from '@wisecom/atlas-types';

/**
 * Exit code for stored content that exists and cannot be read, the `ATLAS_CONTENT_UNREADABLE`
 * category. A command that skipped a damaged manifest or version index still finishes, then exits
 * with it so a scheduler sees the damage on every run until the object is quarantined (#631).
 */
export const EXIT_CONTENT_UNREADABLE = 9;

/**
 * Workload command that owns a storage key, by key prefix. Teams quarantines snapshot indexes
 * only, so its channel cursors and shards get no command.
 */
const WORKLOAD_BY_PREFIX: ReadonlyArray<readonly [prefix: string, workload: string]> = [
  ['manifests/', 'outlook'],
  ['onedrive/', 'onedrive'],
  ['sharepoint/', 'sharepoint'],
  ['contacts/', 'contacts'],
  ['calendar/', 'calendar'],
  ['teams/manifests/', 'teams'],
];

/** The `quarantine` command that moves the object at `key` aside, or undefined for other keys. */
export function quarantine_command_for(key: string): string | undefined {
  const owner = WORKLOAD_BY_PREFIX.find(([prefix]) => key.startsWith(prefix));
  return owner === undefined ? undefined : `atlas ${owner[1]} quarantine --key ${key}`;
}

/**
 * Names each stored object a command skipped because it could not be read, with the command that
 * moves it aside, and sets exit 9 unless an earlier failure already chose a code.
 */
export function report_unreadable_keys(keys: readonly string[] | undefined): void {
  if (keys === undefined || keys.length === 0) return;
  for (const key of keys) logger.error(`  Unreadable stored object: ${key}`);
  logger.error(
    `${keys.length} stored object(s) could not be decrypted or parsed and were skipped -- ` +
      `exit ${EXIT_CONTENT_UNREADABLE}`,
  );
  log_quarantine_hint(keys);
  if (!process.exitCode) process.exitCode = EXIT_CONTENT_UNREADABLE;
}

/** Prints the quarantine command for each key a workload can quarantine. */
export function log_quarantine_hint(keys: readonly string[]): void {
  const commands = keys.map(quarantine_command_for).filter((c): c is string => c !== undefined);
  if (commands.length === 0) return;
  logger.error('If an object is damaged, move it aside so later runs stop reporting it:');
  for (const command of commands) logger.error(`  ${command}`);
}

/** What a listing returned, or the part of it that could be read and the keys it skipped. */
export interface ListingRead<T> {
  readonly result: T;
  readonly unreadable_keys: readonly string[];
}

/**
 * Runs a listing that raises `UnreadableObjectsError` with the readable rows attached, and returns
 * those rows so the command can still print them before it reports the skipped keys.
 */
export async function read_listing<T>(read: () => Promise<T>): Promise<ListingRead<T>> {
  try {
    return { result: await read(), unreadable_keys: [] };
  } catch (err) {
    if (err instanceof UnreadableObjectsError && err.partial_result !== undefined) {
      return { result: err.partial_result as T, unreadable_keys: err.unreadable_keys };
    }
    throw err;
  }
}
