/**
 * Channel messages delta, served from a version range.
 *
 * A root is in the page when its version is newer than `since` and no newer than `at`, and its
 * last activity falls inside the eight-month window. `at` is the channel's change sequence, so
 * each channel has its own versions. Deleted roots become `@removed` markers on later pages only:
 * a first page (no link, `since` 0) lists live roots, as Graph's initial round does. Later pages
 * carry `at` in the skiptoken so the snapshot stays fixed.
 */
import { decode_token, encode_token, GRAPH_BASE, read_top, next_link } from './paging.mjs';
import { root_json } from './serialize.mjs';
import { NOW_MS, DELTA_WINDOW_MS } from '../fixture/generate-tenant.mjs';

/**
 * Items that changed in (since, at], as Graph would page them.
 * @param {object} channel
 * @param {{team: object, tenant_id: string, since: number, at: number}} ctx
 */
export function delta_entries(channel, { team, tenant_id, since, at }) {
  const window_start = NOW_MS - DELTA_WINDOW_MS;
  const out = [];
  for (const root of channel.roots) {
    if (root.deleted_ms !== undefined) {
      if (
        since > 0 &&
        root.deleted_version > since &&
        root.deleted_version <= at &&
        root.deleted_ms >= window_start
      ) {
        out.push({ id: root.id, '@removed': { reason: 'softDelete' } });
      }
      continue;
    }
    if (root.version > since && root.version <= at && root.modified_ms >= window_start) {
      out.push(root_json(root, team, channel, tenant_id));
    }
  }
  return out;
}

/**
 * Serves one delta page. A stored deltaLink holds the previous snapshot as `at`, which becomes the
 * next `since`.
 * @param {{tenant: object, team: object, channel: object, query: URLSearchParams, segments: string[]}} ctx
 */
export function serve_delta_page({ tenant, team, channel, query, segments }) {
  const skip = decode_token(query.get('$skiptoken'));
  const link = decode_token(query.get('$deltatoken'));
  const since = skip.at !== undefined ? skip.since : (link.at ?? 0);
  const at = skip.at ?? channel.seq;
  const offset = Number(skip.o) || 0;
  const top = read_top(query, 100);
  const items = delta_entries(channel, { team, tenant_id: tenant.tenant_id, since, at });
  const body = { value: items.slice(offset, offset + top) };
  if (offset + top < items.length) {
    body['@odata.nextLink'] = next_link(segments, query, { since, at, o: offset + top });
  } else {
    const token = encode_token({ at });
    body['@odata.deltaLink'] =
      `${GRAPH_BASE}/${segments.map(encodeURIComponent).join('/')}?$deltatoken=${token}`;
  }
  return { status: 200, json: body };
}
