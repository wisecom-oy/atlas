import { describe, it, expect } from 'vitest';
import { parse_user_page } from '@/graph-user-page';

describe('parse_user_page', () => {
  it('keeps the users and the next link of a well-formed page', () => {
    const page = parse_user_page({ value: [{ id: 'u1' }], '@odata.nextLink': 'https://next' });

    expect(page).toEqual({ users: [{ id: 'u1' }], next_link: 'https://next' });
  });

  it('reads an empty value as a last page with no users', () => {
    expect(parse_user_page({ value: [] })).toEqual({ users: [], next_link: undefined });
  });

  // Reading these as empty would end discovery early and report a partial mailbox list as
  // complete, or turn a mail lookup into "no such user" (issue #518).
  it.each([null, 'oops', {}, { '@odata.nextLink': 'https://next' }, { value: { id: 'u1' } }])(
    'rejects a malformed page: %j',
    (raw) => {
      expect(() => parse_user_page(raw)).toThrow(/Graph \/users response/);
    },
  );
});
