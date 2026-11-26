import { describe, expect, it } from 'vitest';
import { record_item_failure } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger } from '@wisecom/atlas-types';
import { reopen_refused_roots } from '@/services/backup/refused-root-reopen';

function failure(item_id: string, permanent: boolean): FailedItemLedger {
  return record_item_failure(
    {},
    { item_id, drive_id: 'channel-1', name: item_id, reason: 'Graph 400', permanent },
  );
}

describe('reopen_refused_roots', () => {
  it('drops the permanent flag an older Atlas set on one 400 and keeps the attempt count', () => {
    const ledger = { ...failure('m1', true), ...failure('m2', false) };

    const reopened = reopen_refused_roots(ledger);

    expect(reopened.m1).toEqual({ ...ledger.m1, permanent: undefined });
    expect(reopened.m1).not.toHaveProperty('permanent');
    expect(reopened.m1?.attempts).toBe(1);
    expect(reopened.m2).toEqual(ledger.m2);
  });

  it('returns the ledger unchanged when no root is flagged permanent', () => {
    const ledger = failure('m1', false);

    expect(reopen_refused_roots(ledger)).toBe(ledger);
  });
});
