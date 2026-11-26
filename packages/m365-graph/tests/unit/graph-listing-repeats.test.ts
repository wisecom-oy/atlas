import { describe, expect, it } from 'vitest';
import { create_repeated_listing_filter, drop_repeated_listings } from '@/graph-listing-repeats';

interface Listed {
  readonly id?: string;
  readonly copy: number;
}

const id_of = (item: Listed): string | undefined => item.id;

describe('drop_repeated_listings', () => {
  it('keeps the first copy of each id in listing order', () => {
    const items: Listed[] = [
      { id: 'a', copy: 1 },
      { id: 'b', copy: 1 },
      { id: 'a', copy: 2 },
      { id: 'c', copy: 1 },
      { id: 'b', copy: 2 },
    ];

    expect(drop_repeated_listings(items, id_of)).toEqual([
      { id: 'a', copy: 1 },
      { id: 'b', copy: 1 },
      { id: 'c', copy: 1 },
    ]);
  });

  it('keeps every item without an id, so the caller decides what to do with it', () => {
    const items: Listed[] = [{ copy: 1 }, { id: '', copy: 2 }, { copy: 3 }];

    expect(drop_repeated_listings(items, id_of)).toEqual(items);
  });
});

describe('create_repeated_listing_filter', () => {
  it('drops an id an earlier listing through the same filter returned', () => {
    const keep_first = create_repeated_listing_filter(id_of);

    expect(keep_first([{ id: 'a', copy: 1 }])).toEqual([{ id: 'a', copy: 1 }]);
    expect(
      keep_first([
        { id: 'b', copy: 1 },
        { id: 'a', copy: 2 },
      ]),
    ).toEqual([{ id: 'b', copy: 1 }]);
  });

  it('drops the ids it was seeded with', () => {
    const keep_first = create_repeated_listing_filter(id_of, ['root']);

    expect(
      keep_first([
        { id: 'root', copy: 1 },
        { id: 'a', copy: 1 },
      ]),
    ).toEqual([{ id: 'a', copy: 1 }]);
  });

  it('keeps separate filters independent', () => {
    const first = create_repeated_listing_filter(id_of);
    const second = create_repeated_listing_filter(id_of);
    first([{ id: 'a', copy: 1 }]);

    expect(second([{ id: 'a', copy: 2 }])).toEqual([{ id: 'a', copy: 2 }]);
  });
});
