import type { Client } from '@microsoft/microsoft-graph-client';
import type { EventAttachmentUpload, GraphEventAttachment } from '@wisecom/atlas-types';
import {
  CALENDARS_READ,
  CALENDARS_READ_WRITE,
  CREATE_ONCE,
  collect_pages,
  get_json,
  graph_call,
  mailbox_url,
} from '@/adapters/graph-calendar-requests';

/** Graph accepts inline attachment bodies below 3 MiB; larger files need an upload session. */
const LARGE_ATTACHMENT_THRESHOLD = 3 * 1024 * 1024;
/** ~4 MiB; upload session chunks must be multiples of 320 KiB. */
const UPLOAD_CHUNK_SIZE = 13 * 320 * 1024;

interface AttachmentPayload {
  readonly id: string;
  readonly name?: string;
  readonly contentType?: string;
  readonly isInline?: boolean;
  readonly contentId?: string | null;
  readonly size?: number;
  readonly '@odata.type'?: string;
}

function attachments_url(mailbox_id: string, event_id: string): string {
  return `${mailbox_url(mailbox_id)}/events/${encodeURIComponent(event_id)}/attachments`;
}

function kind_of(odata_type: string | undefined): GraphEventAttachment['kind'] {
  if (odata_type === '#microsoft.graph.itemAttachment') return 'item';
  if (odata_type === '#microsoft.graph.referenceAttachment') return 'reference';
  return 'file';
}

/** Lists an event's attachments without their content. */
export async function list_event_attachments(
  client: Client,
  mailbox_id: string,
  event_id: string,
): Promise<GraphEventAttachment[]> {
  const payloads = await collect_pages<AttachmentPayload>(
    client,
    // contentId exists only on fileAttachment; selecting it unqualified is a 400 BadRequest.
    `${attachments_url(mailbox_id, event_id)}?$select=id,name,contentType,isInline,size,microsoft.graph.fileAttachment/contentId`,
    CALENDARS_READ,
  );
  return payloads.map((payload) => ({
    id: payload.id,
    name: payload.name ?? payload.id,
    kind: kind_of(payload['@odata.type']),
    content_type: payload.contentType,
    is_inline: payload.isInline === true,
    content_id: typeof payload.contentId === 'string' ? payload.contentId : undefined,
    size: payload.size ?? 0,
  }));
}

/** Returns one file attachment's bytes from its base64 `contentBytes`. */
export async function fetch_attachment_content(
  client: Client,
  mailbox_id: string,
  event_id: string,
  attachment_id: string,
): Promise<Uint8Array> {
  const url = `${attachments_url(mailbox_id, event_id)}/${encodeURIComponent(attachment_id)}`;
  const body = await get_json<{ contentBytes?: unknown }>(client, url, CALENDARS_READ);
  if (typeof body.contentBytes !== 'string') throw new Error('Attachment has no contentBytes');
  return Buffer.from(body.contentBytes, 'base64');
}

/** Adds a file attachment to an event, through an upload session when it is 3 MiB or larger. */
export async function upload_event_attachment(
  client: Client,
  mailbox_id: string,
  event_id: string,
  attachment: EventAttachmentUpload,
): Promise<void> {
  const content = Buffer.from(attachment.content);
  const url = attachments_url(mailbox_id, event_id);
  if (content.length < LARGE_ATTACHMENT_THRESHOLD) {
    await graph_call(
      CALENDARS_READ_WRITE,
      (signal) =>
        client
          .api(url)
          .option('signal', signal)
          .post({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: attachment.name,
            contentType: attachment.content_type,
            isInline: attachment.is_inline,
            ...(attachment.content_id === undefined ? {} : { contentId: attachment.content_id }),
            contentBytes: content.toString('base64'),
          }),
      CREATE_ONCE,
    );
    return;
  }
  const session: unknown = await graph_call(CALENDARS_READ_WRITE, () =>
    client.api(`${url}/createUploadSession`).post({
      AttachmentItem: {
        attachmentType: 'file',
        name: attachment.name,
        size: content.length,
        ...(attachment.content_type === undefined ? {} : { contentType: attachment.content_type }),
        isInline: attachment.is_inline,
        ...(attachment.content_id === undefined ? {} : { contentId: attachment.content_id }),
      },
    }),
  );
  const upload_url =
    typeof session === 'object' && session !== null && 'uploadUrl' in session
      ? session.uploadUrl
      : undefined;
  if (typeof upload_url !== 'string') throw new Error('Graph returned no uploadUrl for session');
  for (let offset = 0; offset < content.length; offset += UPLOAD_CHUNK_SIZE) {
    const chunk = content.subarray(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, content.length));
    const range = `bytes ${offset}-${offset + chunk.length - 1}/${content.length}`;
    await graph_call(CALENDARS_READ_WRITE, () =>
      client
        .api(upload_url)
        .header('Content-Range', range)
        .header('Content-Length', String(chunk.length))
        .put(chunk),
    );
  }
}
