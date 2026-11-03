import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  MailboxConnector,
  ManifestEntry,
  RestoreConnector,
  TenantContext,
  TransferProgressReporter,
} from '@wisecom/atlas-types';
import {
  restore_folder_entries,
  restore_single_message,
} from '@/services/restore/restore-execution-orchestrator';

/**
 * Issue #475. A restore reported only run-wide attachment totals, so a message that landed with
 * fewer attachments than its snapshot holds was invisible. Each restored message now carries
 * expected versus uploaded counts by kind, and a shortfall is a verification warning.
 */

const MIME = Buffer.from(
  [
    'From: Jane <jane.doe@example.com>',
    'To: John <john.doe@example.com>',
    'Subject: Quarterly report',
    'Date: Mon, 05 Jan 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/html',
    '',
    '<p>See attached <img src="cid:logo"></p>',
    '--b',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('pdf-bytes').toString('base64'),
    '--b',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-ID: <logo>',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('png-bytes').toString('base64'),
    '--b--',
    '',
  ].join('\r\n'),
);
const JSON_BODY = Buffer.from(JSON.stringify({ subject: 'Old', parentFolderId: 'f1' }));

function sha(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function make_ctx(body: Buffer): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: { get: vi.fn(async () => body) },
    decrypt: (data: Buffer) => data,
  } as unknown as TenantContext;
}

function make_restore(fail_name?: string): RestoreConnector {
  return {
    create_mail_folder: vi.fn(async () => ({ folder_id: 'root', display_name: 'Restore-1' })),
    create_message: vi.fn(async () => 'new-msg'),
    add_attachment: vi.fn(async (_t: string, _o: string, _m: string, att: { name: string }) => {
      if (att.name === fail_name) throw new Error('Graph 500');
    }),
  } as unknown as RestoreConnector;
}

const connector = {
  list_mail_folders: vi.fn(async () => [
    { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox' },
  ]),
} as unknown as MailboxConnector;

async function restore(ctx: TenantContext, entry: ManifestEntry, rc: RestoreConnector) {
  return restore_single_message(
    ctx,
    connector,
    rc,
    't',
    'src@example.com',
    'dst@example.com',
    's',
    entry,
  );
}

const MIME_ENTRY: ManifestEntry = {
  object_id: 'msg-mime',
  storage_key: 'data/x/mime',
  checksum: sha(MIME),
  size_bytes: MIME.length,
  folder_id: 'f1',
  payload_format: 'mime',
};

describe('per-message attachment report', () => {
  it('reports expected and uploaded counts by kind for a healthy MIME restore', async () => {
    const rc = make_restore();
    const result = await restore(make_ctx(MIME), MIME_ENTRY, rc);

    expect(result.messages).toEqual([
      {
        object_id: 'msg-mime',
        target_message_id: 'new-msg',
        target_folder_id: vi.mocked(rc.create_message).mock.calls[0]![2],
        attachments_expected: { file: 1, inline: 1 },
        attachments_uploaded: { file: 1, inline: 1 },
        attachments_failed: 0,
      },
    ]);
    expect(result.verification_warnings).toEqual([]);
  });

  it('shows the shortfall when one MIME attachment fails to upload', async () => {
    const result = await restore(make_ctx(MIME), MIME_ENTRY, make_restore('report.pdf'));

    expect(result.messages[0]).toMatchObject({
      attachments_expected: { file: 1, inline: 1 },
      attachments_uploaded: { file: 0, inline: 1 },
      attachments_failed: 1,
    });
    expect(result.verification_warnings).toEqual(['msg-mime: 1 of 2 attachments restored']);
  });

  it('warns about a legacy attachment that was never stored, which raises no error', async () => {
    const entry: ManifestEntry = {
      object_id: 'msg-json',
      storage_key: 'data/x/json',
      checksum: sha(JSON_BODY),
      size_bytes: JSON_BODY.length,
      folder_id: 'f1',
      attachments: [
        {
          attachment_id: 'a1',
          name: 'big.zip',
          content_type: 'application/zip',
          size_bytes: 5e8,
          storage_key: '',
          checksum: '',
          is_inline: false,
        },
      ],
    };

    const result = await restore(make_ctx(JSON_BODY), entry, make_restore());

    expect(result.errors).toEqual([]);
    expect(result.messages[0]).toMatchObject({
      attachments_expected: { file: 1, inline: 0 },
      attachments_uploaded: { file: 0, inline: 0 },
      attachments_failed: 0,
    });
    expect(result.verification_warnings).toEqual(['msg-json: 0 of 1 attachments restored']);
  });
});

describe('target message and folder ids (issue #569)', () => {
  it('reports the created message and its folder for a MIME entry', async () => {
    const rc = make_distinct_restore();
    const result = await restore(make_ctx(MIME), MIME_ENTRY, rc);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      object_id: 'msg-mime',
      target_message_id: 'new-msg',
      target_folder_id: 'id-Inbox',
    });
  });

  it('reports the created message and its folder for a JSON entry', async () => {
    const rc = make_distinct_restore();
    const result = await restore(make_ctx(JSON_BODY), json_entry('msg-json'), rc);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      object_id: 'msg-json',
      target_message_id: 'new-msg',
      target_folder_id: 'id-Inbox',
    });
  });

  it('leaves a message whose creation failed out of the report and keeps its error', async () => {
    const rc = make_distinct_restore();
    vi.mocked(rc.create_message).mockRejectedValueOnce(new Error('Graph 400'));

    const result = await restore_folder_entries(
      make_ctx(JSON_BODY),
      rc,
      'tenant-1',
      'dst@example.com',
      'id-Inbox',
      [json_entry('msg-fail'), json_entry('msg-ok')],
      0,
      0,
      2,
      Date.now(),
      make_dashboard(),
      () => false,
      {},
    );

    expect(result.errors).toEqual(['msg-fail: Graph 400']);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      object_id: 'msg-ok',
      target_message_id: 'new-msg',
      target_folder_id: 'id-Inbox',
    });
  });
});

/** A JSON entry whose stored payload is JSON_BODY, so it restores without attachments. */
function json_entry(object_id: string): ManifestEntry {
  return {
    object_id,
    storage_key: `data/x/${object_id}`,
    checksum: sha(JSON_BODY),
    size_bytes: JSON_BODY.length,
    folder_id: 'f1',
  };
}

/** Each created folder gets an id derived from its name, so a wrong folder id is visible. */
function make_distinct_restore(): RestoreConnector {
  return {
    create_mail_folder: vi.fn(async (_t: string, _o: string, name: string) => ({
      folder_id: `id-${name}`,
      display_name: name,
      folder_path: name,
      total_item_count: 0,
    })),
    create_message: vi.fn(async () => 'new-msg'),
    add_attachment: vi.fn(),
  } as unknown as RestoreConnector;
}

function make_dashboard(): TransferProgressReporter {
  return {
    mark_active: vi.fn(),
    update_active: vi.fn(),
    update_total: vi.fn(),
    mark_done: vi.fn(),
    mark_all_pending_interrupted: vi.fn(),
    finish: vi.fn(),
  } as unknown as TransferProgressReporter;
}
