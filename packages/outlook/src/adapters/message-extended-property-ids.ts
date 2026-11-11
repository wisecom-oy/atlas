import type { ExtendedProperty, MessageExtendedProperties } from '@wisecom/atlas-types';

const REACTIONS_PROPERTY_SET = '{41F28F13-83F4-4114-A584-EEDB5A6B0BFF}';

/** The MAPI named properties Exchange stores Outlook reactions in (issue #481). */
const REACTION_PROPERTY_IDS = [
  `String ${REACTIONS_PROPERTY_SET} Name OwnerReactionType`,
  `Binary ${REACTIONS_PROPERTY_SET} Name MapiReactionsBlob`,
  `Binary ${REACTIONS_PROPERTY_SET} Name ReactionsSummary`,
];

/** PidTagReceivedOrRenewTime, the time Outlook sorts a message by. */
const RECEIVED_OR_RENEW_TIME = 'SystemTime 0x0F02';

/** PidTagRenewTime, present only once the message has been renewed, as pinning does. */
const RENEW_TIME = 'SystemTime 0x0F01';

/**
 * Outlook on the web and new Outlook pin a message by setting both renew-time properties to
 * 4500-09-01. An unpinned message has no `0x0F01` and a `0x0F02` equal to its receive time, which
 * a restore reproduces from the delivery time (issue #579).
 */
const PIN_PROPERTY_IDS = [RECEIVED_OR_RENEW_TIME, RENEW_TIME];

/** Every property id the batched read asks Graph for. */
export const EXTENDED_PROPERTY_IDS = [...REACTION_PROPERTY_IDS, ...PIN_PROPERTY_IDS];

/**
 * Graph answers a tagged property in its own spelling (`SystemTime 0xf02`), so ids are compared
 * by type and numeric tag rather than as text.
 */
function canonical_tag_id(id: string): string | undefined {
  const match = /^SystemTime 0x([0-9a-f]+)$/i.exec(id);
  if (!match) return undefined;
  return `SystemTime 0x${Number.parseInt(match[1]!, 16).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Sorts the properties Graph returned for one message into reactions and pin. The renew times are
 * kept only when `0x0F01` is present, so a message that was never pinned records nothing.
 */
export function split_extended_properties(
  properties: readonly ExtendedProperty[],
): MessageExtendedProperties {
  const reaction_properties: ExtendedProperty[] = [];
  const renew_times: ExtendedProperty[] = [];
  for (const { id, value } of properties) {
    const tag_id = canonical_tag_id(id);
    if (tag_id !== undefined && PIN_PROPERTY_IDS.includes(tag_id)) {
      renew_times.push({ id: tag_id, value });
    } else {
      reaction_properties.push({ id, value });
    }
  }
  const is_renewed = renew_times.some((p) => p.id === RENEW_TIME);
  return { reaction_properties, pin_properties: is_renewed ? renew_times : [] };
}
