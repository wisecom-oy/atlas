import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import {
  EXIT_CONTENT_UNREADABLE,
  EXIT_FORMAT_UNSUPPORTED,
  quarantine_command_for,
  read_listing,
  report_unreadable_keys,
  report_unsupported_keys,
} from '@/command-unreadable-objects';
import { handle_fatal_error } from '@/fatal-error';

const KEY = 'onedrive/manifests/owner-1/od-snap-1-abc.json';

/**
 * Issue #631: a command that skipped a damaged manifest or version index names it, prints the
 * command that moves it aside, and exits 9 even though it finished, so a scheduler sees it.
 */
describe('reporting unreadable stored objects', () => {
  let previous: typeof process.exitCode;
  let errors: string[];

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    errors = [];
    vi.spyOn(logger, 'error').mockImplementation((message: string) => {
      errors.push(message);
    });
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  it('names each key with its quarantine command and exits 9', () => {
    report_unreadable_keys([KEY]);

    expect(process.exitCode).toBe(EXIT_CONTENT_UNREADABLE);
    expect(errors.join('\n')).toContain(KEY);
    expect(errors.join('\n')).toContain(`atlas onedrive quarantine --key ${KEY}`);
  });

  it('leaves a clean run alone', () => {
    report_unreadable_keys([]);
    report_unreadable_keys(undefined);

    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('never replaces an exit code an earlier failure chose', () => {
    process.exitCode = 2;

    report_unreadable_keys([KEY]);

    expect(process.exitCode).toBe(2);
  });

  it('maps every workload key prefix to its quarantine command', () => {
    expect(quarantine_command_for('manifests/owner/snap.json')).toMatch(/^atlas outlook /);
    expect(quarantine_command_for('sharepoint/index/site/runs/x.json')).toMatch(
      /^atlas sharepoint /,
    );
    expect(quarantine_command_for('contacts/manifests/m/ct-snap-1-a.json')).toMatch(
      /^atlas contacts /,
    );
    expect(quarantine_command_for('calendar/manifests/m/cal-snap-1-a.json')).toMatch(
      /^atlas calendar /,
    );
    expect(quarantine_command_for('teams/manifests/t/teams-snap-1-a.json')).toBe(
      'atlas teams quarantine --key teams/manifests/t/teams-snap-1-a.json',
    );
  });

  it('names newer-format keys without a quarantine command and exits 9 unless a code is set', () => {
    const warnings: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
      warnings.push(message);
    });

    report_unsupported_keys([KEY]);
    expect(process.exitCode).toBe(EXIT_FORMAT_UNSUPPORTED);
    expect(warnings.join('\n')).toContain(KEY);
    expect(warnings.join('\n')).not.toContain('quarantine');

    process.exitCode = 2;
    report_unsupported_keys([KEY]);
    expect(process.exitCode).toBe(2);
  });

  it('gives Teams channel cursors and shards no quarantine command (issue #694)', () => {
    expect(quarantine_command_for('teams/_meta/t/channels/c.json')).toBeUndefined();
    expect(quarantine_command_for('teams/shards/t/c/s.json')).toBeUndefined();
  });

  it('returns the rows a listing could read along with the keys it skipped', async () => {
    const listing = await read_listing(async () => {
      throw new UnreadableObjectsError('1 stored object(s) could not be read', [KEY], {
        partial_result: ['snap-ok'],
      });
    });

    expect(listing).toEqual({ result: ['snap-ok'], unreadable_keys: [KEY] });
  });

  it('lets a failure without readable rows through', async () => {
    const failure = new UnreadableObjectsError('Snapshot cannot be resolved', [KEY]);

    await expect(read_listing(async () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it('gives a fatal unreadable-objects failure exit 9 and the quarantine command', () => {
    handle_fatal_error(new UnreadableObjectsError('Snapshot cannot be resolved', [KEY]));

    expect(process.exitCode).toBe(EXIT_CONTENT_UNREADABLE);
    expect(errors.join('\n')).toContain(`atlas onedrive quarantine --key ${KEY}`);
  });
});
