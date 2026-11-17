/**
 * Graph JSON for teams, members, channels, messages, replies, and hosted contents.
 *
 * Bodies are built from per-object seeds, so nothing is stored per message beyond the model.
 */
import { create_rng } from '../fixture/prng.mjs';
import { encode_token, GRAPH_BASE } from './paging.mjs';

const WORDS = ['status', 'update', 'review', 'handover', 'release', 'ticket', 'plan', 'notes'];
/** Inline replies are capped at this many, mirroring `$expand=replies`. */
export const INLINE_REPLY_LIMIT = 10;

/** @param {number} ms */
export function iso(ms) {
  return new Date(ms).toISOString();
}

/** @param {{id: string, display_name: string}} member */
export function user_json(member) {
  return { user: { id: member.id, displayName: member.display_name, userIdentityType: 'aadUser' } };
}

/** Conversation member, as returned by the team and channel member lists. */
export function member_json(member) {
  return {
    '@odata.type': '#microsoft.graph.aadUserConversationMember',
    id: `m-${member.id}`,
    displayName: member.display_name,
    roles: [],
    userId: member.id,
  };
}

/** Hosted image URL as Teams writes it into a body. The hosted scanner matches on this path. */
export function hosted_src(team, channel, root_id, reply_id, hosted_id) {
  const reply = reply_id ? `/replies/${reply_id}` : '';
  const channel_seg = encodeURIComponent(channel.id);
  return `${GRAPH_BASE}/teams/${team.id}/channels/${channel_seg}/messages/${root_id}${reply}/hostedContents/${hosted_id}/$value`;
}

/** Body HTML: one paragraph of text plus inline hosted images. */
export function body_html(item, team, channel, root_id, reply_id) {
  const word = create_rng(item.text_seed).pick(WORDS);
  const imgs = item.hosted.map(
    (h) => `<img src="${hosted_src(team, channel, root_id, reply_id, h.id)}" alt="">`,
  );
  return `<p>Rig ${word}</p>${imgs.join('')}`;
}

/** Shared chatMessage shape for roots and replies. */
function message_json(item, team, channel, root_id, reply_id) {
  return {
    '@odata.type': '#microsoft.graph.chatMessage',
    id: item.id,
    messageType: 'message',
    createdDateTime: iso(item.created_ms),
    lastModifiedDateTime: iso(item.modified_ms ?? item.created_ms),
    from: item.from ? user_json(item.from) : null,
    body: { contentType: 'html', content: body_html(item, team, channel, root_id, reply_id) },
    attachments: [],
    mentions: [],
    reactions: [],
    channelIdentity: { teamId: team.id, channelId: channel.id },
  };
}

/**
 * Root message for list, get, and delta. Replies are inlined up to the limit; a longer thread
 * gets `replies@odata.nextLink`, which the caller follows to page the rest.
 */
export function root_json(root, team, channel, tenant_id) {
  const json = message_json(root, team, channel, root.id, undefined);
  json.tenantId = tenant_id;
  json.replies = root.replies
    .slice(0, INLINE_REPLY_LIMIT)
    .map((r) => reply_json(r, team, channel, root));
  if (root.replies.length > INLINE_REPLY_LIMIT) {
    const token = encode_token({ o: INLINE_REPLY_LIMIT });
    const channel_seg = encodeURIComponent(channel.id);
    json['replies@odata.nextLink'] =
      `${GRAPH_BASE}/teams/${team.id}/channels/${channel_seg}/messages/${root.id}/replies?$top=50&$skiptoken=${token}`;
  }
  if (root.deleted_ms !== undefined) json.deletedDateTime = iso(root.deleted_ms);
  return json;
}

/** Reply message, linked to its root. */
export function reply_json(reply, team, channel, root) {
  const json = message_json(
    { ...reply, modified_ms: reply.created_ms },
    team,
    channel,
    root.id,
    reply.id,
  );
  json.replyToId = root.id;
  return json;
}
