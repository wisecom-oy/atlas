import type {
  TeamsGraphResource,
  TeamsHostedRef,
  TeamsMessageRef,
  TeamsThread,
  TenantContext,
} from '@wisecom/atlas-types';
import type { HostedOwner } from '@/services/backup/hosted-reference-scanner';
import { error_message } from '@/services/shared/error-message';
import { escape_html } from '@/services/save/html/escape-html';
import { sanitize_message_html } from '@/services/save/html/sanitize-message-html';
import { inline_hosted_images } from '@/services/save/html/hosted-image-inliner';
import { read_message_content, read_verified_blob } from '@/services/save/message-blob-reader';

/** Running totals and non-fatal problems for one export. */
export interface ExportTally {
  errors: string[];
  images_inlined: number;
  messages_saved: number;
}

/** One message as exported: the Graph content plus the rendered HTML fragment. */
export interface SavedMessage {
  readonly id: string;
  readonly author: string;
  readonly created_at: string;
  readonly deleted_at?: string | undefined;
  /** True when the content is the last live version kept from before a deletion. */
  readonly kept_version: boolean;
  readonly content: TeamsGraphResource;
  readonly html: string;
}

/** A root message with its replies, oldest first. */
export interface SavedThread {
  readonly root: SavedMessage;
  readonly replies: SavedMessage[];
}

interface MessageSource {
  readonly blob: { storage_key: string; checksum: string; size_bytes: number };
  readonly hosted: Record<string, TeamsHostedRef>;
  readonly kept_version: boolean;
}

/**
 * Loads one thread from storage. A root that cannot be read drops the whole thread (replies hang
 * off it); unreadable replies are skipped and reported.
 */
export async function load_saved_thread(
  ctx: TenantContext,
  root_id: string,
  thread: TeamsThread,
  tally: ExportTally,
): Promise<SavedThread | undefined> {
  const root = await load_saved_message(ctx, { root_id }, thread.root, tally);
  if (root === undefined) return undefined;
  const replies: SavedMessage[] = [];
  for (const [reply_id, ref] of Object.entries(thread.replies)) {
    const reply = await load_saved_message(ctx, { root_id, reply_id }, ref, tally);
    if (reply !== undefined) replies.push(reply);
  }
  return { root, replies: replies.sort(by_created_at) };
}

/** Sorts messages oldest first. ISO-8601 timestamps order correctly as strings. */
export function by_created_at(a: SavedMessage, b: SavedMessage): number {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

async function load_saved_message(
  ctx: TenantContext,
  owner: HostedOwner,
  ref: TeamsMessageRef,
  tally: ExportTally,
): Promise<SavedMessage | undefined> {
  const source = message_source(ref);
  const label =
    owner.reply_id === undefined ? `message ${owner.root_id}` : `reply ${owner.reply_id}`;
  let content: TeamsGraphResource;
  try {
    content = await read_message_content(ctx, source.blob);
  } catch (err) {
    tally.errors.push(`${label}: ${error_message(err)}`);
    return undefined;
  }
  const html = await render_body(ctx, owner, content, source.hosted, tally);
  tally.messages_saved++;
  return {
    id: owner.reply_id ?? owner.root_id,
    author: author_of(content),
    created_at: typeof content.createdDateTime === 'string' ? content.createdDateTime : '',
    deleted_at: ref.deleted_at,
    kept_version: source.kept_version,
    content,
    html,
  };
}

/**
 * A deleted message shows the last live version kept before the deletion. Without one, the
 * tombstone itself is the only content there is.
 */
function message_source(ref: TeamsMessageRef): MessageSource {
  if (ref.deleted_at !== undefined && ref.kept !== undefined) {
    return { blob: ref.kept, hosted: ref.kept.hosted, kept_version: true };
  }
  return { blob: ref, hosted: ref.hosted, kept_version: false };
}

async function render_body(
  ctx: TenantContext,
  owner: HostedOwner,
  content: TeamsGraphResource,
  hosted: Record<string, TeamsHostedRef>,
  tally: ExportTally,
): Promise<string> {
  const body = content.body as { contentType?: unknown; content?: unknown } | null | undefined;
  const text = typeof body?.content === 'string' ? body.content : '';
  if (body?.contentType === 'text') return `<div class="plain">${escape_html(text)}</div>`;
  // ponytail: body only. Cards and attachment images are not rendered; the JSON keeps them.
  const inlined = await inline_hosted_images(
    sanitize_message_html(text),
    owner,
    hosted,
    async (ref) => {
      const bytes = await read_verified_blob(ctx, ref);
      return `data:${ref.content_type ?? ''};base64,${bytes.toString('base64')}`;
    },
  );
  tally.images_inlined += inlined.inlined;
  tally.errors.push(...inlined.errors);
  return inlined.html;
}

function author_of(content: TeamsGraphResource): string {
  const from = content.from as { user?: { displayName?: unknown } | null } | null | undefined;
  const name = from?.user?.displayName;
  return typeof name === 'string' ? name : '';
}
