import { createHash } from 'node:crypto';
import type { ManifestEntry } from '@wisecom/atlas-types';

/** Stored blobs and manifest entries shared by the MIME and legacy JSON restore tests. */

export const ATTACHMENT_BYTES = Buffer.from('col_a,col_b\n1,2\n', 'utf-8');
export const JSON_ATTACHMENT_BYTES = Buffer.from('stored-attachment-bytes', 'utf-8');

/** RFC 5322 blob as backup stores it for a `payload_format: 'mime'` entry. */
export function build_stored_mime(): Buffer {
  return Buffer.from(
    [
      'Received: from EXCH02.corp.example.com by MAIL01.corp.example.com;',
      '\tTue, 4 Mar 2025 09:15:04 +0000',
      'From: "Nora Partner" <nora@partner.example>',
      'To: "Atlas Admin" <admin@corp.example.com>',
      'Cc: "Audit Log" <audit@corp.example.com>',
      'Subject: Q1 reconciliation figures',
      'Date: Tue, 4 Mar 2025 09:14:58 +0000',
      'Message-ID: <thread-root-9f21@partner.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUTER"',
      '',
      '--OUTER',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<html><body><p>Figures attached.</p></body></html>',
      '',
      '--OUTER',
      'Content-Type: text/csv; name="q1.csv"',
      'Content-Disposition: attachment; filename="q1.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      ATTACHMENT_BYTES.toString('base64'),
      '',
      '--OUTER--',
      '',
    ].join('\r\n'),
    'utf-8',
  );
}

/** Legacy Graph JSON blob, still the format for entries without payload_format. */
export function build_stored_json(): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 'graph-id',
      subject: 'Legacy JSON message',
      body: { contentType: 'html', content: '<p>legacy</p>' },
      toRecipients: [{ emailAddress: { name: 'Admin', address: 'admin@corp.example.com' } }],
      parentFolderId: 'f1',
      receivedDateTime: '2024-06-01T10:00:00Z',
      isRead: true,
    }),
    'utf-8',
  );
}

/** Restore refuses bytes that do not match the entry's checksum (issue #340). */
export function sha(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export const MIME_ENTRY: ManifestEntry = {
  object_id: 'msg-mime',
  storage_key: 'data/user/mime-blob',
  checksum: sha(build_stored_mime()),
  size_bytes: 2048,
  subject: 'Q1 reconciliation figures',
  folder_id: 'f1',
  payload_format: 'mime',
  received_at: '2025-03-04T09:14:58.000Z',
};

export const JSON_ENTRY: ManifestEntry = {
  object_id: 'msg-json',
  storage_key: 'data/user/json-blob',
  checksum: sha(build_stored_json()),
  size_bytes: 512,
  subject: 'Legacy JSON message',
  folder_id: 'f1',
  attachments: [
    {
      attachment_id: 'att-1',
      name: 'legacy.txt',
      content_type: 'text/plain',
      checksum: sha(JSON_ATTACHMENT_BYTES),
      size_bytes: JSON_ATTACHMENT_BYTES.length,
      is_inline: false,
      storage_key: 'data/user/att-blob',
    },
  ],
};
