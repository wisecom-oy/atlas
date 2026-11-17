import { describe, expect, it } from 'vitest';
import {
  EXTENDED_PROPERTY_IDS,
  split_extended_properties,
} from '@/adapters/message-extended-property-ids';

const LIKE = {
  id: 'String {41F28F13-83F4-4114-A584-EEDB5A6B0BFF} Name OwnerReactionType',
  value: 'like',
};
const PINNED_AT = '4500-09-01T00:00:00Z';

/** Issue #579: the pin lives in the renew-time properties, which the backup never read. */
describe('split_extended_properties', () => {
  it('asks Graph for both renew-time properties beside the reactions', () => {
    expect(EXTENDED_PROPERTY_IDS).toEqual(
      expect.arrayContaining([LIKE.id, 'SystemTime 0x0F02', 'SystemTime 0x0F01']),
    );
  });

  it('keeps the renew times of a pinned message, in the canonical id spelling', () => {
    // Graph answers a tagged property as `SystemTime 0xf02`, not as it was asked for.
    const split = split_extended_properties([
      LIKE,
      { id: 'SystemTime 0xf02', value: PINNED_AT },
      { id: 'SystemTime 0xf01', value: PINNED_AT },
    ]);

    expect(split).toEqual({
      reaction_properties: [LIKE],
      pin_properties: [
        { id: 'SystemTime 0x0F02', value: PINNED_AT },
        { id: 'SystemTime 0x0F01', value: PINNED_AT },
      ],
    });
  });

  it('records no pin for a message that was never renewed', () => {
    const split = split_extended_properties([
      { id: 'SystemTime 0xf02', value: '2026-11-01T09:00:00Z' },
    ]);

    expect(split).toEqual({ reaction_properties: [], pin_properties: [] });
  });
});
