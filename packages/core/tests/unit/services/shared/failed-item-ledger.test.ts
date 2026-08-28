import { describe, it, expect } from 'vitest';
import type { FailedItemLedger } from '@wisecom/atlas-types';
import {
  MAX_FAILED_ITEM_ATTEMPTS,
  clear_item_failure,
  describe_failed_items,
  is_retry_exhausted,
  record_item_failure,
  retryable_items,
} from '@/services/shared/failed-item-ledger';

const FAILURE = {
  item_id: 'item-1',
  drive_id: 'drive-a',
  name: 'poison.docx',
  reason: 'HTTP 403 from download URL',
};

/** Applies `record_item_failure` `times` times, as separate runs would. */
function fail_repeatedly(times: number, ledger: FailedItemLedger = {}): FailedItemLedger {
  let current = ledger;
  for (let i = 0; i < times; i++) current = record_item_failure(current, FAILURE);
  return current;
}

describe('record_item_failure', () => {
  it('records a first failure with one attempt', () => {
    const ledger = record_item_failure({}, FAILURE);

    expect(ledger['item-1']).toMatchObject({
      item_id: 'item-1',
      drive_id: 'drive-a',
      name: 'poison.docx',
      reason: 'HTTP 403 from download URL',
      attempts: 1,
    });
  });

  it('increments attempts across runs and keeps the original failure time', () => {
    const first = record_item_failure({}, FAILURE);
    const second = record_item_failure(first, { ...FAILURE, reason: 'HTTP 500' });

    expect(second['item-1']!.attempts).toBe(2);
    expect(second['item-1']!.first_failed_at).toBe(first['item-1']!.first_failed_at);
    expect(second['item-1']!.reason).toBe('HTTP 500');
  });

  it('does not mutate the ledger it was given', () => {
    const original = record_item_failure({}, FAILURE);
    record_item_failure(original, FAILURE);

    expect(original['item-1']!.attempts).toBe(1);
  });

  it('tracks items independently', () => {
    const ledger = record_item_failure(record_item_failure({}, FAILURE), {
      ...FAILURE,
      item_id: 'item-2',
    });

    expect(Object.keys(ledger).sort()).toEqual(['item-1', 'item-2']);
    expect(ledger['item-2']!.attempts).toBe(1);
  });
});

describe('clear_item_failure', () => {
  it('drops the item once it backs up', () => {
    expect(clear_item_failure(record_item_failure({}, FAILURE), 'item-1')).toEqual({});
  });

  it('returns the ledger untouched for an unknown item', () => {
    const ledger = record_item_failure({}, FAILURE);
    expect(clear_item_failure(ledger, 'never-failed')).toBe(ledger);
  });
});

describe('retryable_items', () => {
  it('returns only items belonging to the requested drive', () => {
    const ledger = record_item_failure(record_item_failure({}, FAILURE), {
      ...FAILURE,
      item_id: 'item-2',
      drive_id: 'drive-b',
    });

    expect(retryable_items(ledger, 'drive-a').map((r) => r.item_id)).toEqual(['item-1']);
  });

  it('stops offering an item once its attempts are spent', () => {
    const nearly = fail_repeatedly(MAX_FAILED_ITEM_ATTEMPTS - 1);
    expect(retryable_items(nearly, 'drive-a')).toHaveLength(1);

    const spent = record_item_failure(nearly, FAILURE);
    expect(retryable_items(spent, 'drive-a')).toEqual([]);
  });
});

describe('is_retry_exhausted', () => {
  it('flips exactly at the attempt ceiling', () => {
    const nearly = fail_repeatedly(MAX_FAILED_ITEM_ATTEMPTS - 1);
    expect(is_retry_exhausted(nearly['item-1']!)).toBe(false);

    const spent = record_item_failure(nearly, FAILURE);
    expect(is_retry_exhausted(spent['item-1']!)).toBe(true);
  });
});

describe('describe_failed_items', () => {
  it('says an item will be retried while budget remains', () => {
    const [line] = describe_failed_items(record_item_failure({}, FAILURE));

    expect(line).toContain('poison.docx');
    expect(line).toContain('HTTP 403 from download URL');
    expect(line).toContain(`attempt 1 of ${MAX_FAILED_ITEM_ATTEMPTS}`);
  });

  it('calls an exhausted item permanently skipped', () => {
    const [line] = describe_failed_items(fail_repeatedly(MAX_FAILED_ITEM_ATTEMPTS));

    expect(line).toContain('PERMANENTLY SKIPPED');
    expect(line).not.toContain('will retry');
  });

  it('reports nothing for an empty ledger', () => {
    expect(describe_failed_items({})).toEqual([]);
  });
});

describe('policy-blocked items (issue #53)', () => {
  const BLOCKED = { ...FAILURE, name: 'infected.docx', reason: 'quarantined', permanent: true };

  it('marks the record permanent on the first failure', () => {
    expect(record_item_failure({}, BLOCKED)['item-1']).toMatchObject({
      attempts: 1,
      permanent: true,
    });
  });

  it('is never offered for retry, even on its first attempt', () => {
    const ledger = record_item_failure({}, BLOCKED);

    expect(ledger['item-1']!.attempts).toBe(1);
    expect(retryable_items(ledger, 'drive-a')).toEqual([]);
    expect(is_retry_exhausted(ledger['item-1']!)).toBe(true);
  });

  it('reports a policy refusal rather than a spent attempt budget', () => {
    const [line] = describe_failed_items(record_item_failure({}, BLOCKED));

    expect(line).toContain('infected.docx');
    expect(line).toContain('service policy');
    expect(line).not.toContain('will retry');
    expect(line).not.toContain(`after 1 attempts`);
  });

  it('leaves transient failures retryable', () => {
    expect(retryable_items(record_item_failure({}, FAILURE), 'drive-a')).toHaveLength(1);
  });
});
