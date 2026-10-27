import { describe, it, expect } from 'vitest';
import { parse_user_page } from '@/adapters/graph-mailbox-response-mappers';

describe('parse_user_page', () => {
  it('keeps the users and the next link of a well-formed page', () => {
    const page = parse_user_page({ value: [{ id: 'u1' }], '@odata.nextLink': 'https://next' });

    expect(page).toEqual({ value: [{ id: 'u1' }], '@odata.nextLink': 'https://next' });
  });

  it('reads a page without value as empty', () => {
    expect(parse_user_page({})).toEqual({});
  });

  // An empty read would end discovery early and report a partial mailbox list as complete.
  it.each([null, 'oops', { value: { id: 'u1' } }, { value: 'u1' }])(
    'rejects a malformed page: %j',
    (raw) => {
      expect(() => parse_user_page(raw)).toThrow(/Graph \/users response/);
    },
  );
});
