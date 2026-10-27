/** One page of a Graph `/users` collection; the records are left for the caller to narrow. */
export interface GraphUserPage {
  readonly users: readonly unknown[];
  readonly next_link: string | undefined;
}

/**
 * Narrows an untyped Graph `/users` page. Graph always sends `value` for a collection, an empty
 * array when nothing matched, so a page without it is malformed and throws, as does a non-array
 * `value` (issue #518). Reading it as empty would end tenant discovery with a partial mailbox list
 * reported as complete, or turn a `mail` lookup into "no such user".
 */
export function parse_user_page(raw: unknown): GraphUserPage {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Graph /users response is not an object');
  }
  if (!('value' in raw)) throw new Error('Graph /users response has no value');
  if (!Array.isArray(raw.value)) throw new Error('Graph /users response has a non-array value');
  const next: unknown = '@odata.nextLink' in raw ? raw['@odata.nextLink'] : undefined;
  return { users: raw.value, next_link: typeof next === 'string' ? next : undefined };
}
