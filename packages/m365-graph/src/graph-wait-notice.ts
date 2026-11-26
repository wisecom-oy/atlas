/**
 * The line Atlas prints when a long wait before a Graph request starts, so an unattended run that
 * is waiting out a throttle or an outage can be told from one that hangs (issue #880).
 *
 * One line per wait, at warn level, naming what is waited for, why, and when it ends. A cooldown is
 * announced once, when it is raised: every request parked on it waits for the same end, so ten
 * parked requests still give one line. A retry wait that is not a cooldown belongs to one call and
 * is announced by that call. Waits up to {@link LONG_WAIT_NOTICE_MS} stay silent, as the per-retry
 * line does at the default level.
 */

import type { GraphServicePool, ThrottleCoordinator, ThrottleScope } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { GUID_RE } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { MAX_RETRY_AFTER_MS, extract_requested_retry_after_ms } from '@/graph-retry-after';
import { GraphTokenRequestError } from '@/graph-token-failure';

/**
 * Waits longer than this are announced. A minute is past every wait a healthy run makes: a 30 s
 * default cooldown, a token request's 60 s hold, and the first six backoff delays. Backoff passes it
 * from the seventh retry on, which is when an operator starts to wonder.
 */
export const LONG_WAIT_NOTICE_MS = 60_000;

/** What a cooldown covers, as the coordinator was told when it was raised. */
export interface CooldownTarget {
  readonly coordinator: ThrottleCoordinator;
  readonly pool: GraphServicePool;
  readonly scope: ThrottleScope | undefined;
}

/** Who set the length of a call's wait before its next attempt. */
type RetryWaitKind = 'backoff' | 'retry_after' | 'token_hold';

/** A wait of one call before its next attempt. */
interface RetryWait {
  readonly kind: RetryWaitKind;
  /** The wait asked for or chosen. The threshold is judged on it, before any release jitter. */
  readonly requested_ms: number;
  /** The wait itself, jitter included. */
  readonly delay_ms: number;
  readonly retry: number;
  readonly max_retries: number;
}

const RETRY_WAIT_LABELS: Readonly<Record<RetryWaitKind, string>> = {
  backoff: 'backoff',
  retry_after: 'the Retry-After Microsoft Graph asked for',
  token_hold: 'the hold on token requests after a failed one',
};

/** The end of the last cooldown announced, per coordinator and per pool or owner. */
const announced_cooldown_ends = new WeakMap<ThrottleCoordinator, Map<string, number>>();

/**
 * Announces a cooldown of `duration_ms` just raised on `target`, unless it is short or a cooldown
 * already announced covers it. A raise that extends an announced cooldown by more than the
 * threshold is announced again, since its requests now wait for a later end.
 */
export function announce_cooldown(
  target: CooldownTarget,
  duration_ms: number,
  cause: string,
): void {
  if (duration_ms <= LONG_WAIT_NOTICE_MS) return;
  const ends = ends_for(target.coordinator);
  const key = `${target.pool}:${target.scope?.ownerId ?? ''}`;
  const end_ms = Date.now() + duration_ms;
  if (end_ms <= (ends.get(key) ?? 0) + LONG_WAIT_NOTICE_MS) return;
  ends.set(key, end_ms);
  logger.warn(wait_line(duration_ms, end_ms, `the cooldown on ${describe_target(target)}`, cause));
}

/** Announces one call's wait before its next attempt, when it is long. */
function announce_retry_wait(wait: RetryWait, cause: string): void {
  if (wait.requested_ms <= LONG_WAIT_NOTICE_MS) return;
  const what = `${RETRY_WAIT_LABELS[wait.kind]} before retry ${wait.retry} of ${wait.max_retries}`;
  logger.warn(wait_line(wait.delay_ms, Date.now() + wait.delay_ms, what, cause));
}

/** Announces a cooldown raised by a throttled Graph response, naming the Retry-After it carried. */
export function announce_throttle_cooldown(
  target: CooldownTarget,
  duration_ms: number,
  err: unknown,
): void {
  announce_cooldown(target, duration_ms, describe_throttle_cause(err));
}

/** A call's wait before its next attempt, and the Retry-After or hold that set it, if any. */
export interface RetryDelay {
  readonly delay_ms: number;
  readonly retry_after_ms: number | undefined;
  /** True when the failure raised a cooldown, which {@link announce_throttle_cooldown} announced. */
  readonly cooldown_raised: boolean;
}

/** Which retry a wait comes before, out of how many the call gets. */
export interface RetryPosition {
  readonly retry: number;
  readonly max_retries: number;
}

/**
 * Announces one call's wait before its next retry, labelled by who chose its length: Graph's
 * Retry-After, the hold after a failed token request, or Atlas's backoff. A wait for a cooldown
 * raised on Graph's Retry-After is not announced again: the cooldown's line already covers it.
 */
export function announce_retry_delay(
  err: unknown,
  delay: RetryDelay,
  position: RetryPosition,
): void {
  const base = { delay_ms: delay.delay_ms, ...position };
  const cause = describe_retry_cause(err);
  if (delay.retry_after_ms === undefined) {
    announce_retry_wait({ ...base, kind: 'backoff', requested_ms: delay.delay_ms }, cause);
    return;
  }
  if (delay.cooldown_raised) return;
  const kind = err instanceof GraphTokenRequestError ? 'token_hold' : 'retry_after';
  announce_retry_wait({ ...base, kind, requested_ms: delay.retry_after_ms }, cause);
}

/**
 * Names the response or failure that started a wait by its HTTP status and Graph or transport
 * code only. Graph's prose can quote the request, so it is left out of a line printed by default.
 */
function describe_wait_cause(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'an error';
  const fields = err as Record<string, unknown>;
  const status = fields.statusCode ?? fields.status;
  const parts = [
    typeof status === 'number' ? `HTTP ${status}` : '',
    typeof fields.code === 'string' && fields.code !== '' ? fields.code : '',
  ].filter((part) => part !== '');
  if (parts.length > 0) return parts.join(' ');
  return err instanceof Error ? err.name : 'an error';
}

function ends_for(coordinator: ThrottleCoordinator): Map<string, number> {
  let ends = announced_cooldown_ends.get(coordinator);
  if (!ends) {
    ends = new Map();
    announced_cooldown_ends.set(coordinator, ends);
  }
  return ends;
}

/**
 * The pool or owner a cooldown covers. An owner is named only by its object id: an Outlook owner
 * can be a mailbox address, and that stays out of a line printed by default. Only Outlook and Teams
 * cooldowns carry an owner.
 */
function describe_target(target: CooldownTarget): string {
  const owner = target.scope?.ownerId;
  if (owner === undefined) return `the ${target.pool} pool`;
  return target.pool === 'teams' ? `team ${owner}` : mailbox_label(owner);
}

function mailbox_label(owner: string): string {
  return GUID_RE.test(owner) ? `mailbox ${owner}` : 'the mailbox';
}

function wait_line(duration_ms: number, end_ms: number, what: string, cause: string): string {
  return `Waiting ${format_duration(duration_ms)}, until ${format_end(end_ms)}, for ${what} after ${cause}`;
}

/** Seconds up to two minutes, whole minutes beyond. */
function format_duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** UTC to the second, so lines from hosts in different zones compare directly. */
function format_end(end_ms: number): string {
  return new Date(end_ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The response that raised a cooldown, with the Retry-After Graph sent when it sent one. */
function describe_throttle_cause(err: unknown): string {
  const requested_ms = extract_requested_retry_after_ms(err);
  if (requested_ms === undefined) return describe_wait_cause(err);
  const capped =
    requested_ms > MAX_RETRY_AFTER_MS ? `, capped at ${MAX_RETRY_AFTER_MS / 1000} s` : '';
  return `${describe_wait_cause(err)} with Retry-After ${Math.round(requested_ms / 1000)} s${capped}`;
}

/** The failure a retry waits after; a failed token request is named with Entra ID's status. */
function describe_retry_cause(err: unknown): string {
  if (!(err instanceof GraphTokenRequestError)) return describe_wait_cause(err);
  const status = err.entra_status === undefined ? 'no answer' : `HTTP ${err.entra_status}`;
  return `a failed token request (${status})`;
}
