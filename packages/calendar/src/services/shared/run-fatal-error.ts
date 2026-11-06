import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';

/** Errors that make every further Graph call for the mailbox pointless, so they end the run. */
export function is_run_fatal(err: unknown): err is AuthError | MailboxNotLicensedError {
  return err instanceof AuthError || err instanceof MailboxNotLicensedError;
}
