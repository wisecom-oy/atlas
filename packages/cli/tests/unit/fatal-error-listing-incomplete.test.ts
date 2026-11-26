import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import { handle_fatal_error } from '@/fatal-error';

/** Exit category for a unit listing that ended short of Graph's count (issue #853). */

let previous_exit_code: typeof process.exitCode;
let diagnostics: string[];

beforeEach(() => {
  previous_exit_code = process.exitCode;
  process.exitCode = undefined;
  diagnostics = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    diagnostics.push(args.join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = previous_exit_code;
  vi.restoreAllMocks();
});

describe('fatal listing errors', () => {
  it('exits 2 with ATLAS_LISTING_INCOMPLETE and names both counts', () => {
    handle_fatal_error(new ListingIncompleteError('calendars', 10, 12));

    expect(process.exitCode).toBe(2);
    const output = diagnostics.join('\n');
    expect(output).toContain('Microsoft Graph listed 10 of 12 calendars');
    expect(output).toContain('Atlas code: ATLAS_LISTING_INCOMPLETE');
  });
});
