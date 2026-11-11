import { describe, expect, it } from 'vitest';

import {
  atlas_property_id,
  extended_properties_expand,
  extended_property_value,
} from '@/services/shared/atlas-extended-property';

const TAG = atlas_property_id('AtlasSourceExampleId');

describe('atlas extended properties', () => {
  it('names a property inside the Atlas property set', () => {
    expect(TAG).toBe('String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name AtlasSourceExampleId');
  });

  it('reads the string value of the requested property only', () => {
    const item = {
      singleValueExtendedProperties: [
        { id: 'String {00000000-0000-0000-0000-000000000000} Name Other', value: 'x' },
        { id: TAG, value: 'source-1' },
      ],
    };
    expect(extended_property_value(item, TAG)).toBe('source-1');
  });

  it('returns undefined when the item has no such property or a non-string value', () => {
    expect(extended_property_value({}, TAG)).toBeUndefined();
    expect(
      extended_property_value({ singleValueExtendedProperties: [{ id: TAG, value: 7 }] }, TAG),
    ).toBeUndefined();
  });

  it('builds an encoded expand clause that filters to the given properties', () => {
    const clause = extended_properties_expand([TAG, 'B']);
    expect(clause.startsWith('singleValueExtendedProperties($filter=')).toBe(true);
    expect(decodeURIComponent(clause)).toBe(
      `singleValueExtendedProperties($filter=id eq '${TAG}' or id eq 'B')`,
    );
  });
});
