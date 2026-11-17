/**
 * Assertions shared by the selfcheck scenarios: output files stay clean, and
 * journal entries can be found by a fragment of their redacted URL.
 */
import assert from 'node:assert/strict';
import { BODY_MARKER } from './fake-graph.mjs';
import { LONG_ID, SECRET_BEARER, SECRET_CLIENT } from './fault-shapes-child.mjs';

/** Asserts none of the secrets, body content, raw addresses or command arguments appear in `text`. */
export function assert_clean(text, label, extra = []) {
  const needles = [SECRET_BEARER, 'SECRET_BEARER_TOKEN', SECRET_CLIENT, BODY_MARKER];
  for (const needle of [...needles, 'user@example.com', LONG_ID, ...extra]) {
    assert.ok(!text.includes(needle), `${label} contains '${needle.slice(0, 24)}'`);
  }
  const tenant = TENANT_CONTENT.exec(text);
  assert.ok(!tenant, `${label} contains tenant content '${tenant?.[0]}'`);
}

/** Tenant, site, file and person names used by the fixtures; none may survive redaction. */
export const TENANT_CONTENT = /contoso|finance|budget|jane/i;

/** Finds the one journal entry whose redacted URL contains `fragment`. */
export function entry_for(entries, fragment) {
  const found = entries.filter((e) => e.url.includes(fragment));
  assert.equal(found.length, 1, `expected one entry for ${fragment}, found ${found.length}`);
  return found[0];
}
