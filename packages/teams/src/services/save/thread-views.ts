import type {
  TeamsGraphResource,
  TeamsHostedRef,
  TeamsMessageRef,
  TeamsThread,
} from '@wisecom/atlas-types';
import type { HostedOwner } from '@/services/backup/hosted-reference-scanner';
import { error_message } from '@/services/shared/error-message';
import { escape_html } from '@/services/save/html/escape-html';
import { sanitize_message_html } from '@/services/save/html/sanitize-message-html';
import { inline_hosted_images } from '@/services/save/html/hosted-image-inliner';
import { export_hosted_contents, owner_label } from '@/services/save/hosted-content-export';
import type { SavedHostedFile, ThreadExportContext } from '@/services/save/export-types';
import { read_message_content } from '@/services/save/message-blob-reader';

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
  /** Hosted contents of this version written to the archive. */
  readonly hosted: SavedHostedFile[];
  /** Hosted content IDs the backup never captured for this version. */
  readonly hosted_missing: string[];
}

/** A root message with its replies, oldest first. */
export interface SavedThread {
  readonly root: SavedMessage;
  readonly replies: SavedMessage[];
}

interface MessageSource {
  readonly blob: { storage_key: string; checksum: string; size_bytes: number };
  readonly hosted: Record<string, TeamsHostedRef>;
  readonly hosted_missing: string[];
  readonly kept_version: boolean;
}

/**
 * Loads one thread from storage. A root that cannot be read drops the whole thread (replies hang
 * off it); unreadable replies are skipped and reported.
 */
export async function load_saved_thread(
  context: ThreadExportContext,
  root_id: string,
  thread: TeamsThread,
): Promise<SavedThread | undefined> {
  const root = await load_saved_message(context, { root_id }, thread.root);
  if (root === undefined) return undefined;
  const replies: SavedMessage[] = [];
  for (const [reply_id, ref] of Object.entries(thread.replies)) {
    const reply = await load_saved_message(context, { root_id, reply_id }, ref);
    if (reply !== undefined) replies.push(reply);
  }
  return { root, replies: replies.sort(by_created_at) };
}

/** Sorts messages oldest first. ISO-8601 timestamps order correctly as strings. */
export function by_created_at(a: SavedMessage, b: SavedMessage): number {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

async function load_saved_message(
  context: ThreadExportContext,
  owner: HostedOwner,
  ref: TeamsMessageRef,
): Promise<SavedMessage | undefined> {
  const source = message_source(ref);
  let content: TeamsGraphResource;
  try {
    content = await read_message_content(context.ctx, source.blob);
  } catch (err) {
    context.tally.errors.push(`${owner_label(owner)}: ${error_message(err)}`);
    return undefined;
  }
  const hosted = await export_hosted_contents(context, owner, source.hosted, source.hosted_missing);
  const rendered = render_body(owner, content, hosted.data_uris);
  context.tally.images_inlined += rendered.inlined;
  context.tally.messages_saved++;
  return {
    id: owner.reply_id ?? owner.root_id,
    author: author_of(content),
    created_at: typeof content.createdDateTime === 'string' ? content.createdDateTime : '',
    deleted_at: ref.deleted_at,
    kept_version: source.kept_version,
    content,
    html: rendered.html,
    hosted: hosted.files,
    hosted_missing: hosted.missing,
  };
}

/**
 * A deleted message shows the last live version kept before the deletion. Without one, the
 * tombstone itself is the only content there is. The kept version does not record the hosted
 * contents the backup missed, so none are listed for it.
 */
function message_source(ref: TeamsMessageRef): MessageSource {
  if (ref.deleted_at !== undefined && ref.kept !== undefined) {
    return { blob: ref.kept, hosted: ref.kept.hosted, hosted_missing: [], kept_version: true };
  }
  return {
    blob: ref,
    hosted: ref.hosted,
    hosted_missing: ref.hosted_missing ?? [],
    kept_version: false,
  };
}

/** The message body as HTML, with its images embedded from `data_uris`. */
function render_body(
  owner: HostedOwner,
  content: TeamsGraphResource,
  data_uris: ReadonlyMap<string, string>,
): { html: string; inlined: number } {
  const body = content.body as { contentType?: unknown; content?: unknown } | null | undefined;
  const text = typeof body?.content === 'string' ? body.content : '';
  if (body?.contentType === 'text') {
    return { html: `<div class="plain">${escape_html(text)}</div>`, inlined: 0 };
  }
  // ponytail: body only. Cards and attachments are not rendered; their hosted files are written and
  // messages.json lists them.
  return inline_hosted_images(sanitize_message_html(text), owner, data_uris);
}

function author_of(content: TeamsGraphResource): string {
  const from = content.from as { user?: { displayName?: unknown } | null } | null | undefined;
  const name = from?.user?.displayName;
  return typeof name === 'string' ? name : '';
}
