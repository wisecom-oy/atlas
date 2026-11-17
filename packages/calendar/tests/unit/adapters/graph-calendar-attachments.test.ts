import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';

import {
  fetch_attachment_content,
  list_event_attachments,
  upload_event_attachment,
} from '@/adapters/graph-calendar-attachments';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const EVENT = 'evt-1';
const ATTACHMENTS = `/users/${MAILBOX}/events/${EVENT}/attachments`;
const SESSION_URL = 'https://upload.example.com/session-1';
const MIB = 1024 * 1024;
/** Graph upload session chunks: 13 × 320 KiB, the same size the adapter uses. */
const CHUNK = 13 * 320 * 1024;

/** A route that hands out an upload session for `createUploadSession` and accepts every other call. */
function client_for(route: (call: GraphCall) => unknown = session_route) {
  const graph = stub_graph_client(route, { record_headers: true });
  return { client: graph.client as unknown as Client, calls: graph.calls };
}

function session_route(call: GraphCall): unknown {
  return call.url.endsWith('createUploadSession') ? { uploadUrl: SESSION_URL } : {};
}

/** Deterministic bytes, so a reassembled upload can be compared with the original exactly. */
function bytes_of(length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out;
}

function upload(content: Buffer) {
  return { name: 'report.pdf', content_type: 'application/pdf', is_inline: false, content };
}

describe('upload_event_attachment below the 3 MiB threshold', () => {
  it('posts the file inline with its bytes base64-encoded', async () => {
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, upload(Buffer.from('hello')));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'post',
      url: ATTACHMENTS,
      body: {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'report.pdf',
        contentType: 'application/pdf',
        isInline: false,
      },
    });
    expect(calls[0]).toMatchObject({
      body: { contentBytes: Buffer.from('hello').toString('base64') },
    });
  });

  it('keeps a file one byte under 3 MiB on the inline path', async () => {
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, upload(bytes_of(3 * MIB - 1)));

    expect(calls.map((c) => c.url)).toEqual([ATTACHMENTS]);
  });
});

describe('upload_event_attachment at or above 3 MiB', () => {
  it('switches to an upload session at exactly 3 MiB', async () => {
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, upload(bytes_of(3 * MIB)));

    expect(calls[0]).toMatchObject({
      method: 'post',
      url: `${ATTACHMENTS}/createUploadSession`,
      body: { AttachmentItem: { attachmentType: 'file', name: 'report.pdf', size: 3 * MIB } },
    });
    expect(calls.slice(1).map((c) => c.method)).toEqual(['put']);
  });

  it('sends the content in ranged chunks that reassemble to the original file', async () => {
    const content = bytes_of(2 * CHUNK + 1);
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, upload(content));

    const puts = calls.filter((c) => c.method === 'put');
    expect(puts.map((c) => c.url)).toEqual([SESSION_URL, SESSION_URL, SESSION_URL]);
    expect(puts.map((c) => c.headers?.['Content-Range'])).toEqual([
      `bytes 0-${CHUNK - 1}/${content.length}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${content.length}`,
      `bytes ${2 * CHUNK}-${2 * CHUNK}/${content.length}`,
    ]);
    const sent = Buffer.concat(puts.map((c) => c.body as Buffer));
    expect(sent.equals(content)).toBe(true);
  });

  it('uses chunks that are whole multiples of 320 KiB, as Graph requires', async () => {
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, upload(bytes_of(CHUNK + 1)));

    const first_chunk = calls.find((c) => c.method === 'put')!.body as Buffer;
    expect(first_chunk.length % (320 * 1024)).toBe(0);
  });

  it('fails without sending any chunk when Graph returns no upload URL', async () => {
    const { client, calls } = client_for(() => ({}));

    await expect(
      upload_event_attachment(client, MAILBOX, EVENT, upload(bytes_of(3 * MIB))),
    ).rejects.toThrow('no uploadUrl');

    expect(calls.map((c) => c.method)).toEqual(['post']);
  });
});

describe('fetch_attachment_content', () => {
  it('decodes the base64 contentBytes into the file bytes', async () => {
    const { client, calls } = client_for(() => ({
      contentBytes: Buffer.from('abc').toString('base64'),
    }));

    const bytes = await fetch_attachment_content(client, MAILBOX, EVENT, 'att-1');

    expect(Buffer.from(bytes).toString()).toBe('abc');
    expect(calls[0]!.url).toBe(`${ATTACHMENTS}/att-1`);
  });

  it('fails when Graph omits contentBytes', async () => {
    const { client } = client_for(() => ({}));

    await expect(fetch_attachment_content(client, MAILBOX, EVENT, 'att-1')).rejects.toThrow(
      'no contentBytes',
    );
  });
});

describe('list_event_attachments', () => {
  it('maps file, item and reference attachments to their kinds', async () => {
    const { client } = client_for(() => ({
      value: [
        {
          id: 'a1',
          name: 'agenda.pdf',
          '@odata.type': '#microsoft.graph.fileAttachment',
          contentType: 'application/pdf',
          isInline: true,
          size: 10,
        },
        { id: 'a2', '@odata.type': '#microsoft.graph.itemAttachment' },
        { id: 'a3', name: 'Spec', '@odata.type': '#microsoft.graph.referenceAttachment' },
      ],
    }));

    const attachments = await list_event_attachments(client, MAILBOX, EVENT);

    expect(attachments).toEqual([
      {
        id: 'a1',
        name: 'agenda.pdf',
        kind: 'file',
        content_type: 'application/pdf',
        is_inline: true,
        size: 10,
      },
      { id: 'a2', name: 'a2', kind: 'item', content_type: undefined, is_inline: false, size: 0 },
      {
        id: 'a3',
        name: 'Spec',
        kind: 'reference',
        content_type: undefined,
        is_inline: false,
        size: 0,
      },
    ]);
  });
});

describe('list_event_attachments contentId', () => {
  it('asks Graph for contentId through the fileAttachment type, never unqualified', async () => {
    const { client, calls } = client_for(() => ({ value: [] }));

    await list_event_attachments(client, MAILBOX, EVENT);

    const select = new URL(calls[0]!.url, 'https://graph.example.com').searchParams.get('$select');
    const fields = select?.split(',') ?? [];
    expect(fields).toContain('microsoft.graph.fileAttachment/contentId');
    expect(fields).not.toContain('contentId');
  });

  it('maps an inline image contentId and turns a null one into undefined', async () => {
    const { client } = client_for(() => ({
      value: [
        {
          id: 'a1',
          name: 'logo.png',
          '@odata.type': '#microsoft.graph.fileAttachment',
          isInline: true,
          contentId: 'cid-logo',
        },
        {
          id: 'a2',
          name: 'pixel.png',
          '@odata.type': '#microsoft.graph.fileAttachment',
          isInline: false,
          contentId: null,
        },
      ],
    }));

    const attachments = await list_event_attachments(client, MAILBOX, EVENT);

    expect(attachments.map((a) => a.content_id)).toEqual(['cid-logo', undefined]);
  });
});

describe('upload_event_attachment contentId', () => {
  it('sends contentId on the inline POST when the attachment has one', async () => {
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, {
      ...upload(Buffer.from('png')),
      is_inline: true,
      content_id: 'cid-logo',
    });

    expect(calls[0]!.body).toMatchObject({ isInline: true, contentId: 'cid-logo' });
  });

  it('omits contentId from the inline POST when the attachment has none', async () => {
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, upload(Buffer.from('hello')));

    expect(calls[0]!.body).not.toHaveProperty('contentId');
  });

  it('sends contentId in the upload session AttachmentItem when the attachment has one', async () => {
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, {
      ...upload(bytes_of(3 * MIB)),
      is_inline: true,
      content_id: 'cid-logo',
    });

    expect(calls[0]!.body).toMatchObject({
      AttachmentItem: { isInline: true, contentId: 'cid-logo' },
    });
  });

  it('omits contentId from the upload session AttachmentItem when the attachment has none', async () => {
    const { client, calls } = client_for();

    await upload_event_attachment(client, MAILBOX, EVENT, upload(bytes_of(3 * MIB)));

    expect(calls[0]!.body).toHaveProperty('AttachmentItem');
    expect(calls[0]!.body).not.toHaveProperty('AttachmentItem.contentId');
  });
});
