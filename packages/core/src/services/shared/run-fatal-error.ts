import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';

/**
 * Errors that refuse every further Graph call for the owner, so they end the run rather than fail
 * one item: a missing grant or a rejected credential (`AuthError`), and an unlicensed mailbox.
 */
export function is_run_fatal_error(err: unknown): err is AuthError | MailboxNotLicensedError {
  return err instanceof AuthError || err instanceof MailboxNotLicensedError;
}
