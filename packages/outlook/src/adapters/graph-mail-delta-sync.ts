import type { Client } from '@microsoft/microsoft-graph-client';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import type { DeltaPageCallback, DeltaSyncResult, MailMessage } from '@wisecom/atlas-types';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { GraphPageResponse, GraphDeltaMessage } from '@/adapters/graph-delta-message-mapper';
import { DELTA_SELECT_FIELDS, extract_page_messages } from '@/adapters/graph-delta-message-mapper';

// Graph's default message/folder IDs change on every folder move; immutable
// IDs do not. Must be sent on EVERY request that produces or consumes an ID —
// mixing formats corrupts correlation (issue #48).
export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

/**
 * What one `fetch_delta` call has already reported. An invalid delta link can be rejected after
 * earlier pages were handed to `on_page`, so the full re-enumeration that follows must neither hand
 * those messages over again nor drop the removals those pages carried (issue #642).
 */
export interface DeltaHandover {
  readonly removed_ids: string[];
  readonly handed_over_ids: Set<string>;
}

/** One delta pass over a mail folder: from a saved link, or a full enumeration without one. */
export interface MailDeltaPass {
  readonly owner_id: string;
  readonly folder_id: string;
  readonly prev_delta_link: string | undefined;
  readonly delta_reset: boolean;
  readonly page_size: number;
  readonly on_page?: DeltaPageCallback | undefined;
}

/** Returns an empty handover for a new `fetch_delta` call. */
export function create_delta_handover(): DeltaHandover {
  return { removed_ids: [], handed_over_ids: new Set() };
}

/**
 * Fetches a page using a full @odata.nextLink or @odata.deltaLink URL.
 * The Prefer headers are re-sent on each request (page size + immutable IDs);
 * Graph requires the IdType preference on every request that handles IDs.
 */
export async function fetch_mail_continuation_page(
  client: Client,
  full_url: string,
  page_size: number,
): Promise<GraphPageResponse> {
  return with_graph_retry(
    () =>
      client
        .api(full_url)
        .header('Prefer', `odata.maxpagesize=${page_size}, ${IMMUTABLE_ID_PREFER}`)
        .get() as Promise<GraphPageResponse>,
  );
}

/**
 * Fetches the first page of an initial delta request using the SDK fluent API.
 * Uses Prefer: odata.maxpagesize to request larger pages and reduce round-trips.
 * The server may return fewer items; $top is intentionally avoided as it caps
 * total results across pages for delta queries.
 */
async function fetch_initial_delta_page(
  client: Client,
  owner_id: string,
  folder_id: string,
  page_size: number,
): Promise<GraphPageResponse> {
  return with_graph_retry(
    () =>
      client
        .api(`/users/${owner_id}/mailFolders/${folder_id}/messages/delta`)
        .header('Prefer', `odata.maxpagesize=${page_size}, ${IMMUTABLE_ID_PREFER}`)
        .select(DELTA_SELECT_FIELDS)
        .get() as Promise<GraphPageResponse>,
  );
}

/**
 * Runs one delta pass for a folder, paging through all results and converting each message
 * directly (the body is in the delta response, so no per-message fetches are needed). Removals
 * accumulate into the handover, and a message the handover already passed to on_page is skipped.
 * Throws when the round ends on a page without a delta link; a round on_page stops early returns
 * an empty `delta_link` instead.
 */
export async function run_mail_delta_pass(
  client: Client,
  pass: MailDeltaPass,
  handover: DeltaHandover,
): Promise<DeltaSyncResult> {
  const { owner_id, folder_id, prev_delta_link, page_size, on_page } = pass;
  const messages: MailMessage[] = [];
  let delta_link = '';
  let page_count = 0;
  let total_streamed = 0;

  let page: GraphPageResponse = prev_delta_link
    ? await fetch_mail_continuation_page(client, prev_delta_link, page_size)
    : await fetch_initial_delta_page(client, owner_id, folder_id, page_size);

  while (true) {
    page_count++;
    const items = (page.value ?? []) as GraphDeltaMessage[];
    const page_messages = extract_page_messages(items, handover.removed_ids).filter(
      (message) => !handover.handed_over_ids.has(message.message_id),
    );

    const callback_result = await hand_page_over(
      on_page,
      page_count,
      total_streamed,
      page_messages,
      messages,
      handover.handed_over_ids,
    );
    total_streamed = callback_result.new_total_streamed;

    if (page['@odata.deltaLink']) {
      delta_link = page['@odata.deltaLink'];
    }

    if (callback_result.should_continue === false) break;

    const next_url = page['@odata.nextLink'];
    if (!next_url) {
      assert_final_page_has_delta_link(page);
      break;
    }

    page = await fetch_mail_continuation_page(client, next_url, page_size);
  }

  return { messages, removed_ids: handover.removed_ids, delta_link, delta_reset: pass.delta_reset };
}

/**
 * Throws when the page that ends a delta round carries no `@odata.deltaLink`.
 *
 * Graph ends every complete round with that link. A last page with neither link means the round
 * was cut short, so the messages on the pages never requested are not in the result. Returning it
 * as finished reported the folder `[ok]` with those messages missing (issue #851).
 */
function assert_final_page_has_delta_link(page: GraphPageResponse): void {
  if (page['@odata.deltaLink']) return;
  throw new Error(
    'Graph ended the message delta of this folder without a delta link, so the read is ' +
      'incomplete and the folder is read again next run',
  );
}

/**
 * Invokes the page callback, recording its messages as handed over, or accumulates them when
 * there is no callback; returns the continuation flag.
 */
async function hand_page_over(
  on_page: DeltaPageCallback | undefined,
  page_count: number,
  total_streamed: number,
  page_messages: MailMessage[],
  messages: MailMessage[],
  handed_over_ids: Set<string>,
): Promise<{ should_continue: boolean | void; new_total_streamed: number }> {
  if (!on_page) {
    append_all(messages, page_messages);
    return { should_continue: true, new_total_streamed: total_streamed };
  }

  for (const message of page_messages) handed_over_ids.add(message.message_id);
  const new_total_streamed = total_streamed + page_messages.length;
  const cb_result = on_page(page_count, new_total_streamed, page_messages);
  const should_continue = cb_result instanceof Promise ? await cb_result : cb_result;
  return { should_continue, new_total_streamed };
}
