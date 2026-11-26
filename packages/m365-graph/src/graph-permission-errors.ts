import { GraphError } from '@microsoft/microsoft-graph-client';
import {
  MailboxNotLicensedError,
  MissingGraphPermissionsError,
  NotFoundError,
} from '@wisecom/atlas-types';

/**
 * Graph error codes, lower-cased, that mean the app registration lacks a grant (issue #865).
 *
 * - `accessDenied`: driveItem and most Graph-native resources.
 * - `ErrorAccessDenied`: the Exchange-backed mail, calendar and contacts APIs.
 * - `Authorization_RequestDenied`: the directory, such as listing users.
 *
 * A 403 with any other code, or with none, is a refusal of the one request it answered. A missing
 * grant is answered with one of these codes in a JSON error body; a 403 without a body, such as
 * one from a proxy, names no cause and is not reported as one. Keep this list in step with "Partial runs" in
 * `docs/operations/reliability.md`.
 */
const MISSING_GRANT_CODES: ReadonlySet<string> = new Set([
  'accessdenied',
  'erroraccessdenied',
  'authorization_requestdenied',
]);

/**
 * Teams answers a missing role permission, and a protected API Microsoft has not approved for the
 * tenant, with the generic code `Forbidden`. Counting it as a grant refusal keeps an unapproved
 * `ChannelMessage.Read.All` an exit `4` naming the permissions, instead of a failed channel on
 * every run.
 */
const TEAMS_MISSING_GRANT_CODES: ReadonlySet<string> = new Set([
  ...MISSING_GRANT_CODES,
  'forbidden',
]);

/**
 * Rethrows a Graph 403 on a mail, calendar, contacts or directory call. A missing-grant code
 * becomes `MissingGraphPermissionsError` naming the permissions to grant; any other 403 becomes a
 * `GraphError` naming the code Graph sent, so the caller fails only that request. Returns for
 * anything that is not a 403.
 *
 * Callers on a mailbox check `rethrow_if_mailbox_not_licensed` first: Graph can answer an
 * unlicensed mailbox with 403 too (issue #40).
 */
export function rethrow_if_access_denied(
  err: unknown,
  required_permissions?: readonly string[],
): void {
  rethrow_if_forbidden(
    err,
    required_permissions ?? [
      'Mail.Read              -- read mailbox messages',
      'Mail.ReadWrite         -- delta sync and full message fetch',
      'User.Read.All          -- list tenant users / mailboxes',
      'MailboxSettings.Read   -- enumerate mail folders',
    ],
    MISSING_GRANT_CODES,
  );
}

/**
 * Rethrows a Graph 403 on a Teams call: a missing-grant code, `Forbidden` included, as
 * `MissingGraphPermissionsError` naming the Teams permissions, any other 403 as a `GraphError`
 * naming its code. Returns for anything that is not a 403.
 */
export function rethrow_if_teams_access_denied(err: unknown): void {
  rethrow_if_forbidden(
    err,
    [
      'Team.ReadBasic.All       -- list teams and read team settings',
      'TeamSettings.Read.All    -- read team settings',
      'TeamMember.Read.All      -- list team members',
      'Channel.ReadBasic.All    -- list channels and tabs',
      'ChannelMember.Read.All   -- list channel members',
      'ChannelMessage.Read.All  -- read channel messages and replies',
      'TeamsTab.Read.All        -- read channel tabs',
    ],
    TEAMS_MISSING_GRANT_CODES,
  );
}

/** True for a Graph 403 whose code means a missing grant on a mail, calendar or directory call. */
export function is_missing_grant_refusal(err: unknown): boolean {
  const fields = as_error_fields(err);
  return fields.statusCode === 403 && names_missing_grant(fields, MISSING_GRANT_CODES);
}

/** Rethrows a Graph 403 as the missing grant or the request refusal its code names. */
function rethrow_if_forbidden(
  err: unknown,
  required: readonly string[],
  grant_codes: ReadonlySet<string>,
): void {
  const fields = as_error_fields(err);
  if (fields.statusCode !== 403) return;
  if (names_missing_grant(fields, grant_codes)) throw missing_grant_error(err, fields, required);
  throw refused_request_error(err, fields);
}

/** True when the error's Graph code is one of `grant_codes`, compared without case. */
function names_missing_grant(
  fields: Record<string, unknown>,
  grant_codes: ReadonlySet<string>,
): boolean {
  const code = graph_code_of(fields);
  return code !== undefined && grant_codes.has(code.toLowerCase());
}

/** The missing-grant error, naming the code Graph sent and the Application permissions to grant. */
function missing_grant_error(
  err: unknown,
  fields: Record<string, unknown>,
  required: readonly string[],
): MissingGraphPermissionsError {
  const graph_code = graph_code_of(fields);
  const hint =
    `Microsoft Graph returned 403 Forbidden (${graph_code}).\n` +
    `The app registration needs these Application permissions with admin consent:\n\n` +
    required.map((p) => `  - ${p}`).join('\n') +
    `\n\n` +
    `Grant them in Azure Portal > App registrations > API permissions > ` +
    `Add a permission > Microsoft Graph > Application permissions, ` +
    `then click "Grant admin consent".`;

  return new MissingGraphPermissionsError(hint, {
    permissions: required.map(permission_name),
    status_code: 403,
    graph_code,
    cause: err,
  });
}

/**
 * A 403 whose code does not name a missing grant, as a `GraphError` that keeps the status and the
 * code, so status checks still read it, and whose message names the code. Not an `AuthError`, so
 * the caller fails the one request instead of the run.
 */
function refused_request_error(err: unknown, fields: Record<string, unknown>): GraphError {
  const graph_code = graph_code_of(fields);
  const detail = err instanceof Error && err.message.trim() !== '' ? `: ${err.message.trim()}` : '';
  const named = graph_code === undefined ? 'with no error code' : graph_code;
  const refusal = new GraphError(
    403,
    `Microsoft Graph returned 403 ${named}, which does not name a missing permission${detail}`,
  );
  refusal.code = graph_code ?? null;
  if (typeof fields.requestId === 'string') refusal.requestId = fields.requestId;
  if (fields.headers instanceof Headers) refusal.headers = fields.headers;
  refusal.cause = err;
  return refusal;
}

/** The Graph error code the error carries, or undefined when it carries none. */
function graph_code_of(fields: Record<string, unknown>): string | undefined {
  const code = fields.code;
  return typeof code === 'string' && code.trim() !== '' ? code.trim() : undefined;
}

/** The permission name at the start of a guidance line such as `Mail.Read  -- read messages`. */
function permission_name(entry: string): string {
  return entry.trim().split(/\s+/)[0] ?? entry;
}

/**
 * Detects MailboxNotEnabledForRESTAPI from Graph and rethrows with
 * actionable guidance about reassigning an Exchange Online license.
 */
export function rethrow_if_mailbox_not_licensed(err: unknown): void {
  const graph_err = as_error_fields(err);
  const code = String(graph_err.code ?? '');
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'MailboxNotEnabledForRESTAPI' || message.includes('MailboxNotEnabledForRESTAPI')) {
    throw new MailboxNotLicensedError(
      `The mailbox is not licensed for API access (MailboxNotEnabledForRESTAPI).\n` +
        `This typically happens when the user's Exchange Online license has been removed.\n` +
        `The mailbox data is retained for 30 days after license removal, but cannot be\n` +
        `accessed via the Graph API until a license is reassigned.\n\n` +
        `To back up or restore this mailbox:\n` +
        `  1. Reassign an Exchange Online license to the user in Microsoft 365 admin center\n` +
        `  2. Wait a few minutes for the mailbox to reconnect\n` +
        `  3. Run the operation again\n` +
        `  4. Remove the license after the operation completes (if desired)`,
      { cause: err },
    );
  }
}

/**
 * Detects a 404 from a OneDrive lookup and rethrows it as a `NotFoundError`.
 *
 * Graph answers `GET /users/{id}/drives` and `/users/{id}/drive` with 404 "User's mysite not
 * found." when the user has never opened OneDrive, which is the normal state of every admin and
 * service account in a tenant. Left untyped it reached consumers as a bare Graph error with no
 * class and no code, so retry policies treated a permanent answer as transient and re-asked it
 * once per attempt (issue #403). Reported as a missing grant it sent operators to Entra to grant
 * permissions they already held (issue #404). A missing grant is a 403, and
 * `rethrow_if_access_denied` still owns that.
 */
export function rethrow_if_no_onedrive(err: unknown, owner_id: string): void {
  if (as_error_fields(err).statusCode !== 404) return;
  throw new NotFoundError(no_onedrive_message(owner_id), { cause: err });
}

/** The message both the 404 path and the empty-drive-id path report. */
export function no_onedrive_message(owner_id: string): string {
  return (
    `No OneDrive is provisioned for ${owner_id}.\n` +
    `Microsoft Graph answers 404 for a user who has never opened OneDrive, which is normal for ` +
    `admin and service accounts.\n` +
    `This is not a permissions problem: a missing grant is reported as 403 ErrorAccessDenied. ` +
    `Provision the drive by signing in to OneDrive once as that user, or exclude the account ` +
    `from the run.`
  );
}

/**
 * Reads a thrown value as a bag of fields.
 *
 * `unknown` is not `object`: a rejected promise can carry `null`, and asserting the type only
 * silences the compiler. Both helpers are called from `catch` blocks that must fall through for
 * an unrelated failure, so a `TypeError` here would replace the real error with a bug.
 */
function as_error_fields(err: unknown): Record<string, unknown> {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
}
