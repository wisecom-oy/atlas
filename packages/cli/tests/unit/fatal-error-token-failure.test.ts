import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, GraphUnavailableError } from '@wisecom/atlas-types';
import { handle_fatal_error } from '@/fatal-error';

/**
 * Issue #786: exit categories for a failed Microsoft Graph token request. A wrong client secret
 * exited 1 because the Graph SDK reported it as a `statusCode: -1` error with no cause.
 */

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

/** What MSAL reports for Entra ID's answer to a wrong client secret. */
function invalid_client_answer(): Error {
  return Object.assign(new Error('invalid_client: AADSTS7000215'), {
    name: 'ServerError',
    errorCode: 'invalid_client',
    status: 401,
  });
}

describe('fatal token request failures', () => {
  it('exits 4 with ATLAS_AUTH_DENIED when Entra ID refused the client secret', () => {
    handle_fatal_error(
      new AuthError(
        'Microsoft Entra ID refused the Graph token request: HTTP 401 (invalid_client)',
        {
          cause: invalid_client_answer(),
        },
      ),
    );

    expect(process.exitCode).toBe(4);
    const output = diagnostics.join('\n');
    expect(output).toContain('Atlas code: ATLAS_AUTH_DENIED');
    expect(output).toContain('Cause: invalid_client: AADSTS7000215');
  });

  it('exits 4 when the refusal arrives still inside its Graph SDK carrier', () => {
    const refusal = new AuthError('Microsoft Entra ID refused the Graph token request', {
      cause: invalid_client_answer(),
    });
    handle_fatal_error(
      Object.assign(new Error(refusal.message, { cause: refusal }), {
        name: 'GraphTokenRequestError',
        entra_status: 401,
      }),
    );

    expect(process.exitCode).toBe(4);
    expect(diagnostics.join('\n')).toContain('Atlas code: ATLAS_AUTH_DENIED');
  });

  it('exits 3 when the token request kept getting no response', () => {
    handle_fatal_error(
      new GraphUnavailableError(
        'Microsoft Entra ID did not issue a Graph token after 12 retries over 1410 s: no response (network_error)',
        { retries: 12, elapsed_ms: 1_410_000 },
      ),
    );

    expect(process.exitCode).toBe(3);
    expect(diagnostics.join('\n')).toContain('Atlas code: ATLAS_GRAPH_UNAVAILABLE');
  });
});
