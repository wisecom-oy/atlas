import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';

/**
 * Error handling shared by the status commands that peek at Graph delta state.
 *
 * A status peek used to catch every error and report the folder or drive as "not up to date", so
 * a revoked permission read as pending changes and the command exited 0 (issue #630). Backups
 * rethrow the same failures (#372), and status has to agree with them: an operator who runs
 * status before a backup must learn that the backup cannot run, not that it has work to do.
 */

const AUTH_STATUS_CODES = new Set([401, 403]);

/**
 * Rethrows a peek failure that no other folder or drive can escape: a missing grant, a rejected
 * token, or an unlicensed mailbox. A bare Graph 401 or 403 that no connector classified becomes
 * an `AuthError`, so SDK callers get the same class the CLI maps to exit code 4.
 */
export function rethrow_if_peek_fatal(err: unknown): void {
  if (err instanceof AuthError || err instanceof MailboxNotLicensedError) throw err;
  const status = http_status_of(err);
  if (status !== undefined && AUTH_STATUS_CODES.has(status)) {
    throw new AuthError(
      `Microsoft Graph returned ${status} while reading delta state. ` +
        `Check the app registration's credentials and Application permissions.`,
      { cause: err },
    );
  }
}

/** Names a non-fatal peek failure as `<ErrorClass>: <message>`, for the status result and its log line. */
export function describe_peek_error(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `Error: ${String(err)}`;
}

function http_status_of(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const fields = err as Record<string, unknown>;
  const status = fields.statusCode ?? fields.status;
  return typeof status === 'number' ? status : undefined;
}
