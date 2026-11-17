/**
 * Route table for the Teams endpoints the backup calls.
 *
 * Each route declares its limiter class: `messages` for chat message endpoints (including hosted
 * contents) and `default` for everything else. Placeholders capture ids by name.
 */
import { create_rng } from '../fixture/prng.mjs';
import { GraphHttpError, page_collection } from './paging.mjs';
import { member_json, root_json, reply_json } from './serialize.mjs';
import { serve_delta_page } from './delta.mjs';

const CH = ['teams', ':team', 'channels', ':channel'];
const MSG = [...CH, 'messages', ':message'];
const REPLY = [...MSG, 'replies', ':reply'];

/** @type {Array<{method: string, pattern: string[], cls: 'messages'|'default', handler: Function}>} */
export const ROUTES = [
  { method: 'GET', pattern: ['teams'], cls: 'default', handler: list_teams },
  { method: 'GET', pattern: ['teams', ':team'], cls: 'default', handler: get_team },
  { method: 'GET', pattern: ['teams', ':team', 'members'], cls: 'default', handler: team_members },
  {
    method: 'GET',
    pattern: ['teams', ':team', 'channels'],
    cls: 'default',
    handler: team_channels,
  },
  { method: 'GET', pattern: [...CH, 'members'], cls: 'default', handler: channel_members },
  { method: 'GET', pattern: [...CH, 'tabs'], cls: 'default', handler: channel_tabs },
  {
    method: 'GET',
    pattern: [...CH, 'sharedWithTeams'],
    cls: 'default',
    handler: shared_with_teams,
  },
  { method: 'GET', pattern: [...CH, 'filesFolder'], cls: 'default', handler: files_folder },
  {
    method: 'GET',
    pattern: [...CH, 'messages', 'delta'],
    cls: 'messages',
    handler: messages_delta,
  },
  { method: 'GET', pattern: [...CH, 'messages'], cls: 'messages', handler: list_messages },
  { method: 'GET', pattern: MSG, cls: 'messages', handler: get_message },
  { method: 'GET', pattern: [...MSG, 'replies'], cls: 'messages', handler: list_replies },
  { method: 'GET', pattern: [...MSG, 'hostedContents'], cls: 'messages', handler: list_hosted },
  {
    method: 'GET',
    pattern: [...MSG, 'hostedContents', ':hosted', '$value'],
    cls: 'messages',
    handler: hosted_value,
  },
  {
    method: 'GET',
    pattern: [...REPLY, 'hostedContents'],
    cls: 'messages',
    handler: list_reply_hosted,
  },
  {
    method: 'GET',
    pattern: [...REPLY, 'hostedContents', ':hosted', '$value'],
    cls: 'messages',
    handler: reply_hosted_value,
  },
];

/**
 * Finds the route for a method and decoded path segments.
 * @returns {{route: object, params: Record<string, string>} | null}
 */
export function match_route(method, segments) {
  for (const route of ROUTES) {
    if (route.method !== method || route.pattern.length !== segments.length) continue;
    const params = {};
    const ok = route.pattern.every((p, i) => {
      if (p.startsWith(':')) {
        params[p.slice(1)] = segments[i];
        return true;
      }
      return p === segments[i];
    });
    if (ok) return { route, params };
  }
  return null;
}

/** Looks up a team or raises a Graph 404. */
function team_of(tenant, id) {
  const team = tenant.team_by_id.get(id);
  if (!team) throw new GraphHttpError(404, 'ResourceNotFound');
  return team;
}

/** Looks up a channel or raises a Graph 404. */
function channel_of(tenant, params) {
  const team = team_of(tenant, params.team);
  const channel = team.channel_by_id.get(params.channel);
  if (!channel) throw new GraphHttpError(404, 'ResourceNotFound');
  return { team, channel };
}

/** Looks up a root message or raises a Graph 404. */
function root_of(channel, id) {
  const root = channel.root_by_id.get(id);
  if (!root) throw new GraphHttpError(404, 'ResourceNotFound');
  return root;
}

function list_teams({ tenant, query, segments }) {
  return page_collection({
    items: tenant.teams,
    segments,
    query,
    serialize: (t) => ({ id: t.id, displayName: t.display_name, tenantId: tenant.tenant_id }),
  });
}

function get_team({ tenant, params }) {
  const t = team_of(tenant, params.team);
  return {
    status: 200,
    json: { id: t.id, displayName: t.display_name, tenantId: tenant.tenant_id },
  };
}

function team_members({ tenant, params, query, segments }) {
  return page_collection({
    items: team_of(tenant, params.team).members,
    segments,
    query,
    serialize: member_json,
  });
}

function team_channels({ tenant, params, query, segments }) {
  const team = team_of(tenant, params.team);
  return page_collection({
    items: team.channels,
    segments,
    query,
    serialize: (c) => ({
      id: c.id,
      displayName: c.display_name,
      email: c.email,
      membershipType: 'standard',
      tenantId: tenant.tenant_id,
    }),
  });
}

function channel_members({ tenant, params, query, segments }) {
  const { channel } = channel_of(tenant, params);
  return page_collection({ items: channel.members, segments, query, serialize: member_json });
}

function channel_tabs({ tenant, params, query, segments }) {
  const { channel } = channel_of(tenant, params);
  return page_collection({
    items: channel.tabs,
    segments,
    query,
    serialize: (tab) => ({
      id: tab.id,
      displayName: tab.display_name,
      teamsApp: { id: 'rig-app', displayName: 'Rig app' },
    }),
  });
}

function shared_with_teams({ tenant, params, query, segments }) {
  channel_of(tenant, params);
  return page_collection({ items: [], segments, query, serialize: (x) => x });
}

function files_folder({ tenant, params }) {
  const { channel } = channel_of(tenant, params);
  if (channel.files_mode === 'missing') throw new GraphHttpError(404, 'ItemNotFound');
  if (channel.files_mode === 'forbidden') throw new GraphHttpError(403, 'Forbidden');
  return {
    status: 200,
    json: {
      id: `folder-${slug(channel)}`,
      name: channel.display_name,
      parentReference: { driveId: `drive-${slug(channel)}` },
      webUrl: 'https://example.invalid/rig/folder',
    },
  };
}

/** Stable URL-safe name for a channel's synthetic folder. */
function slug(channel) {
  return channel.display_name.replace(/\W+/g, '-');
}

function messages_delta(ctx) {
  const { channel, team } = channel_of(ctx.tenant, ctx.params);
  return serve_delta_page({
    tenant: ctx.tenant,
    team,
    channel,
    query: ctx.query,
    segments: ctx.segments,
  });
}

function list_messages({ tenant, params, query, segments }) {
  const { team, channel } = channel_of(tenant, params);
  return page_collection({
    items: channel.roots,
    segments,
    query,
    serialize: (root) => root_json(root, team, channel, tenant.tenant_id),
  });
}

function get_message({ tenant, params }) {
  const { team, channel } = channel_of(tenant, params);
  return {
    status: 200,
    json: root_json(root_of(channel, params.message), team, channel, tenant.tenant_id),
  };
}

function list_replies({ tenant, params, query, segments }) {
  const { team, channel } = channel_of(tenant, params);
  const root = root_of(channel, params.message);
  const items = root.deleted_ms !== undefined ? [] : root.replies;
  return page_collection({
    items,
    segments,
    query: withDefaultTop(query),
    serialize: (reply) => reply_json(reply, team, channel, root),
  });
}

/** Replies page at 50 unless the caller asks otherwise, matching the replies endpoint. */
function withDefaultTop(query) {
  if (query.has('$top')) return query;
  const q = new URLSearchParams(query);
  q.set('$top', '50');
  return q;
}

function list_hosted({ tenant, params, query, segments }) {
  const { channel } = channel_of(tenant, params);
  const root = root_of(channel, params.message);
  return page_collection({ items: root.hosted, segments, query, serialize: hosted_json });
}

function list_reply_hosted({ tenant, params, query, segments }) {
  const { channel } = channel_of(tenant, params);
  const root = root_of(channel, params.message);
  const reply = root.replies.find((r) => r.id === params.reply);
  if (!reply || root.deleted_ms !== undefined) throw new GraphHttpError(404, 'ResourceNotFound');
  return page_collection({ items: reply.hosted, segments, query, serialize: hosted_json });
}

function hosted_value({ tenant, params }) {
  const { channel } = channel_of(tenant, params);
  const root = root_of(channel, params.message);
  return hosted_bytes(root.hosted, params.hosted);
}

function reply_hosted_value({ tenant, params }) {
  const { channel } = channel_of(tenant, params);
  const root = root_of(channel, params.message);
  const reply = root.replies.find((r) => r.id === params.reply);
  if (!reply) throw new GraphHttpError(404, 'ResourceNotFound');
  return hosted_bytes(reply.hosted, params.hosted);
}

/** Hosted list entries carry no bytes, as in the real endpoint. */
function hosted_json(h) {
  return {
    '@odata.type': '#microsoft.graph.chatMessageHostedContent',
    id: h.id,
    contentType: h.content_type,
  };
}

/** Returns deterministic image bytes for one hosted id. */
function hosted_bytes(list, id) {
  const h = list.find((x) => x.id === id);
  if (!h) throw new GraphHttpError(404, 'ResourceNotFound');
  return { status: 200, bytes: create_rng(h.seed).bytes(h.size), content_type: h.content_type };
}
