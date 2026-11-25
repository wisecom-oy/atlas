import { describe, expect, it } from 'vitest';
import {
  record_item_failure,
  retryable_items,
  type FailedItemLedger,
  type FailedItemRecord,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  NOT_FOUND_CONFIRMATION_READS,
  NOT_FOUND_CONFIRMATION_WINDOW_MS,
  resolve_retry_read_not_found,
} from '@/backup/retry-read-not-found';

// Issue #850: one `404` on the re-read of a listed file cleared it from the failed-items list, and
// delta never re-presents an unchanged file, so it was missing from every later snapshot while the
// run reported HEALTHY. A "not found" answer now keeps the file listed until it repeats on enough
// runs over enough time to be a deletion rather than a passing fault.

const HOUR_MS = 60 * 60 * 1000;
const START = new Date('2026-11-01T00:00:00.000Z');

function at(offset_ms: number): Date {
  return new Date(START.getTime() + offset_ms);
}

function listed_after_own_failures(attempts: number): FailedItemLedger {
  let ledger: FailedItemLedger = {};
  for (let i = 0; i < attempts; i++) {
    ledger = record_item_failure(ledger, {
      item_id: 'item-1',
      drive_id: 'drive-1',
      name: 'report.docx',
      reason: 'size mismatch',
    });
  }
  return ledger;
}

function record_of(ledger: FailedItemLedger): FailedItemRecord {
  const record = ledger['item-1'];
  if (!record) throw new Error('item-1 is no longer listed');
  return record;
}

/** Runs the re-read once per given time, each answering "not found", and returns the ledger. */
function not_found_on_runs(ledger: FailedItemLedger, run_times: Date[]): FailedItemLedger {
  let next = ledger;
  for (const now of run_times) {
    if (!next['item-1']) break;
    next = resolve_retry_read_not_found(next, record_of(next), now);
  }
  return next;
}

describe('resolve_retry_read_not_found', () => {
  it('keeps a file listed after one "not found" answer, without spending an attempt', () => {
    const ledger = not_found_on_runs(listed_after_own_failures(1), [at(0)]);

    expect(record_of(ledger)).toMatchObject({
      attempts: 1,
      not_found: { reads: 1, since: START.toISOString() },
    });
    expect(record_of(ledger).reason).toContain('not found');
    expect(retryable_items(ledger, 'drive-1')).toHaveLength(1);
  });

  it('never spends the last attempt of a file that keeps answering "not found"', () => {
    const ledger = not_found_on_runs(listed_after_own_failures(4), [at(0), at(HOUR_MS)]);

    expect(record_of(ledger).attempts).toBe(4);
    expect(retryable_items(ledger, 'drive-1')).toHaveLength(1);
  });

  it('keeps the file through many runs inside one incident shorter than the window', () => {
    const quarter_hourly = Array.from({ length: 20 }, (_, i) => at(i * 15 * 60 * 1000));

    const ledger = not_found_on_runs(listed_after_own_failures(1), quarter_hourly);

    expect(record_of(ledger).not_found).toEqual({ reads: 20, since: START.toISOString() });
  });

  it('keeps the file when two daily runs span the window with fewer reads than required', () => {
    const ledger = not_found_on_runs(listed_after_own_failures(1), [at(0), at(48 * HOUR_MS)]);

    expect(record_of(ledger).not_found?.reads).toBe(2);
  });

  it('clears the file once the answer repeats on enough runs across the window', () => {
    const daily = Array.from({ length: NOT_FOUND_CONFIRMATION_READS }, (_, i) =>
      at(i * NOT_FOUND_CONFIRMATION_WINDOW_MS),
    );

    const ledger = not_found_on_runs(listed_after_own_failures(1), daily);

    expect(ledger).toEqual({});
  });

  it('clears an hourly-scheduled file once the window has passed', () => {
    const hourly = Array.from({ length: 30 }, (_, i) => at(i * HOUR_MS));
    let ledger = listed_after_own_failures(1);
    let cleared_at_hour: number | undefined;

    for (const [hour, now] of hourly.entries()) {
      ledger = resolve_retry_read_not_found(ledger, record_of(ledger), now);
      if (!ledger['item-1']) {
        cleared_at_hour = hour;
        break;
      }
    }

    expect(cleared_at_hour).toBe(NOT_FOUND_CONFIRMATION_WINDOW_MS / HOUR_MS);
  });

  it('starts the streak over after any other failure of the file', () => {
    let ledger = not_found_on_runs(listed_after_own_failures(1), [at(0), at(24 * HOUR_MS)]);
    ledger = record_item_failure(ledger, {
      item_id: 'item-1',
      drive_id: 'drive-1',
      name: 'report.docx',
      reason: 'size mismatch',
    });
    expect(record_of(ledger).not_found).toBeUndefined();

    ledger = not_found_on_runs(ledger, [at(48 * HOUR_MS)]);

    expect(record_of(ledger).not_found).toEqual({
      reads: 1,
      since: at(48 * HOUR_MS).toISOString(),
    });
  });

  it('restarts a streak whose start time cannot be read, so it can still be confirmed', () => {
    const listed = record_of(listed_after_own_failures(1));
    const corrupt: FailedItemLedger = {
      'item-1': { ...listed, not_found: { reads: 7, since: 'not a date' } },
    };

    const ledger = not_found_on_runs(corrupt, [at(0)]);

    expect(record_of(ledger).not_found).toEqual({ reads: 1, since: START.toISOString() });
  });

  it('leaves the other files on the list alone', () => {
    const other = record_item_failure(listed_after_own_failures(1), {
      item_id: 'item-2',
      drive_id: 'drive-1',
      name: 'notes.txt',
      reason: 'size mismatch',
    });

    const ledger = not_found_on_runs(other, [at(0)]);

    expect(ledger['item-2']).toEqual(other['item-2']);
  });
});
