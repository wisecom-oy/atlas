import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GraphAccessRefusedError,
  GraphUnavailableError,
  MissingGraphPermissionsError,
} from '@wisecom/atlas-types';
import { handle_fatal_error } from '@/fatal-error';

/** Exit categories for the Graph failures typed by issues #772 and #773. */

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

describe('fatal Graph errors', () => {
  it('exits 4 with ATLAS_ACCESS_REFUSED for a refused site, not the blanket auth code', () => {
    const cause = { statusCode: 403, code: 'accessDenied' };
    handle_fatal_error(
      new GraphAccessRefusedError(
        'Microsoft Graph refused SharePoint site s-1',
        { site_id: 's-1' },
        'access_refused',
        {
          status_code: 403,
          graph_code: 'accessDenied',
          cause,
        },
      ),
    );

    expect(process.exitCode).toBe(4);
    const output = diagnostics.join('\n');
    expect(output).toContain('Atlas code: ATLAS_ACCESS_REFUSED');
    expect(output).not.toContain('ATLAS_AUTH_DENIED');
    expect(output).toContain('HTTP status: 403');
  });

  it('exits 4 with ATLAS_AUTH_DENIED for a missing grant', () => {
    handle_fatal_error(
      new MissingGraphPermissionsError('needs Sites.Read.All', { permissions: ['Sites.Read.All'] }),
    );

    expect(process.exitCode).toBe(4);
    expect(diagnostics.join('\n')).toContain('Atlas code: ATLAS_AUTH_DENIED');
  });

  it('exits 3 with ATLAS_GRAPH_UNAVAILABLE for an exhausted 5xx, printing a non-empty message', () => {
    const cause = Object.assign(new Error(''), { statusCode: 504, body: '' });
    handle_fatal_error(
      new GraphUnavailableError(
        'Microsoft Graph was unavailable after 12 retries: HTTP 504',
        {
          retries: 12,
          elapsed_ms: 1_400_000,
        },
        { status_code: 504, cause },
      ),
    );

    expect(process.exitCode).toBe(3);
    const output = diagnostics.join('\n');
    expect(output).toContain('Microsoft Graph was unavailable after 12 retries: HTTP 504');
    expect(output).toContain('Atlas code: ATLAS_GRAPH_UNAVAILABLE');
  });
});
