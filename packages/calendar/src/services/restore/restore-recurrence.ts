import type { GraphEventPayload } from '@wisecom/atlas-types';
import type { RestoreWriteDeps } from '@/services/restore/restore-event-writer';
import { build_exception_patch } from '@/services/restore/restore-event-payload';
import { error_message } from '@/services/shared/error-message';
import { is_record } from '@/services/shared/json-record';
import { is_run_fatal } from '@/services/shared/run-fatal-error';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `OID.<master id>.<yyyy-mm-dd>`: the date of a cancelled occurrence in the series' zone. */
const CANCELLED_OCCURRENCE = /\.(\d{4}-\d{2}-\d{2})$/;

function zone_of(master: Readonly<Record<string, unknown>>): string {
  const start = master['start'];
  const zone = is_record(start) ? start['timeZone'] : undefined;
  return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
}

function start_date_time(event: Readonly<Record<string, unknown>>): string {
  const start = event['start'];
  const value = is_record(start) ? start['dateTime'] : undefined;
  return typeof value === 'string' ? value : '';
}

/** Lists the restored series' instances in a window of a day either side of `instant_ms`. */
async function instances_around(
  deps: RestoreWriteDeps,
  series_id: string,
  instant_ms: number,
  time_zone: string,
): Promise<GraphEventPayload[]> {
  return deps.connector.list_series_instances(deps.tenant_id, deps.target_mailbox_id, series_id, {
    start: new Date(instant_ms - DAY_MS).toISOString(),
    end: new Date(instant_ms + 2 * DAY_MS).toISOString(),
    time_zone,
  });
}

/** Patches the restored occurrence that the stored exception replaced. */
async function apply_exception(
  deps: RestoreWriteDeps,
  series_id: string,
  exception: Readonly<Record<string, unknown>>,
  time_zone: string,
): Promise<void> {
  const original = typeof exception['originalStart'] === 'string' ? exception['originalStart'] : '';
  const original_ms = Date.parse(original);
  if (Number.isNaN(original_ms)) throw new Error('exception has no originalStart');
  const instances = await instances_around(deps, series_id, original_ms, time_zone);
  const match = instances.find(
    (instance) =>
      typeof instance['originalStart'] === 'string' &&
      Date.parse(instance['originalStart']) === original_ms,
  );
  if (match === undefined) throw new Error(`no occurrence at ${original} in the restored series`);
  await deps.connector.update_event(
    deps.tenant_id,
    deps.target_mailbox_id,
    match.id,
    build_exception_patch(exception),
  );
}

/** Removes the restored occurrence on the date the source series had cancelled. */
async function apply_cancellation(
  deps: RestoreWriteDeps,
  series_id: string,
  date: string,
  time_zone: string,
): Promise<void> {
  const instances = await instances_around(
    deps,
    series_id,
    Date.parse(`${date}T00:00:00Z`),
    time_zone,
  );
  const match = instances.find(
    (instance) => instance['type'] === 'occurrence' && start_date_time(instance).startsWith(date),
  );
  if (match === undefined) throw new Error(`no occurrence on ${date} in the restored series`);
  await deps.connector.delete_occurrence(deps.tenant_id, deps.target_mailbox_id, match.id);
}

/** Runs one replay step, turning a non-fatal failure into a message. */
async function attempt(
  failures: string[],
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    if (is_run_fatal(err)) throw err;
    failures.push(`${label} not applied: ${error_message(err)}`);
  }
}

/**
 * Replays a stored series master's exceptions and cancellations onto the series just created
 * from it. Each failure is returned as a message; the series itself stays restored.
 */
export async function replay_recurrence_changes(
  deps: RestoreWriteDeps,
  master: Readonly<Record<string, unknown>>,
  series_id: string,
): Promise<string[]> {
  const zone = zone_of(master);
  const failures: string[] = [];
  const exceptions: unknown = master['exceptionOccurrences'];
  for (const exception of Array.isArray(exceptions) ? exceptions.filter(is_record) : []) {
    await attempt(failures, `exception ${String(exception['originalStart'])}`, () =>
      apply_exception(deps, series_id, exception, zone),
    );
  }
  const cancelled: unknown = master['cancelledOccurrences'];
  for (const occurrence of Array.isArray(cancelled) ? cancelled : []) {
    const date =
      typeof occurrence === 'string' ? CANCELLED_OCCURRENCE.exec(occurrence)?.[1] : undefined;
    if (date === undefined) continue;
    await attempt(failures, `cancellation on ${date}`, () =>
      apply_cancellation(deps, series_id, date, zone),
    );
  }
  return failures;
}
