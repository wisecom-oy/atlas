import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { GraphAttachmentRecord } from '@/adapters/graph-mailbox-response-mappers';
import {
  detect_item_attachment_content_type,
  item_attachment_filename,
  map_attachments,
  resolve_downloaded_attachment,
} from '@/adapters/graph-attachment-mapper';

const file_record: GraphAttachmentRecord = {
  '@odata.type': '#microsoft.graph.fileAttachment',
  id: 'att-file',
  name: 'report.pdf',
  contentType: 'application/pdf',
  size: 9,
  contentBytes: Buffer.from('hello pdf').toString('base64'),
};

const item_record: GraphAttachmentRecord = {
  '@odata.type': '#microsoft.graph.itemAttachment',
  id: 'att-item',
  name: 'FW escalation',
  size: 4096,
};

const reference_record: GraphAttachmentRecord = {
  '@odata.type': '#microsoft.graph.referenceAttachment',
  id: 'att-ref',
  name: 'budget.xlsx',
  sourceUrl: 'https://contoso.sharepoint.com/sites/fin/budget.xlsx',
};

describe('map_attachments', () => {
  it('maps a file attachment with its inline content', () => {
    const [mapped] = map_attachments([file_record]);

    expect(mapped?.content_type).toBe('application/pdf');
    expect(mapped?.content.toString('utf-8')).toBe('hello pdf');
  });

  it('keeps an item attachment for download instead of dropping it', () => {
    const [mapped] = map_attachments([item_record]);

    expect(mapped).toBeDefined();
    expect(mapped?.attachment_id).toBe('att-item');
    expect(mapped?.content).toHaveLength(0);
    // A non-zero size is what makes the connector fetch /$value.
    expect(mapped?.size_bytes).toBeGreaterThan(0);
  });

  it('gives an item attachment a downloadable size even when Graph reports zero', () => {
    const [mapped] = map_attachments([{ ...item_record, size: 0 }]);

    expect(mapped?.size_bytes).toBeGreaterThan(0);
  });

  it('stores a reference attachment as a uri-list, since it has no bytes', () => {
    const [mapped] = map_attachments([reference_record]);

    expect(mapped?.content_type).toBe('text/uri-list');
    expect(mapped?.content.toString('utf-8').trim()).toBe(
      'https://contoso.sharepoint.com/sites/fin/budget.xlsx',
    );
    // Graph answers 405 for a reference attachment's /$value, so content must
    // already be present or the connector would try to download it.
    expect(mapped?.content.length).toBeGreaterThan(0);
    expect(mapped?.size_bytes).toBe(mapped?.content.length);
  });

  it('maps every type in one message', () => {
    const mapped = map_attachments([file_record, item_record, reference_record]);

    expect(mapped.map((a) => a.attachment_id)).toEqual(['att-file', 'att-item', 'att-ref']);
  });
});

describe('map_attachments with unexpected input', () => {
  let warn_spy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn_spy.mockRestore();
  });

  it('records an unknown attachment type rather than silently skipping it', () => {
    const mapped = map_attachments([
      { '@odata.type': '#microsoft.graph.somethingNew', id: 'att-x', name: 'mystery' },
    ]);

    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.name).toBe('mystery');
    expect(warn_spy).toHaveBeenCalled();
    const warned = warn_spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toContain('somethingNew');
  });

  it('skips a record with no type at all, which is not an attachment', () => {
    expect(map_attachments([{ id: 'att-nil' }])).toHaveLength(0);
  });

  it('warns when a reference attachment carries no sourceUrl', () => {
    const { sourceUrl: _dropped, ...no_source } = reference_record;
    const mapped = map_attachments([no_source]);

    expect(mapped).toHaveLength(1);
    expect(warn_spy).toHaveBeenCalled();
  });
});

describe('detect_item_attachment_content_type', () => {
  it('names an attached calendar invite', () => {
    const ical = Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n');
    expect(detect_item_attachment_content_type(ical)).toBe('text/calendar');
  });

  it('names an attached contact card', () => {
    const vcard = Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alice\r\n');
    expect(detect_item_attachment_content_type(vcard)).toBe('text/vcard');
  });

  it('names an attached message', () => {
    const mime = Buffer.from('Received: from mail.contoso.com\r\nFrom: a@b.com\r\n\r\nbody');
    expect(detect_item_attachment_content_type(mime)).toBe('message/rfc822');
  });

  it('tolerates leading whitespace and lowercase keywords', () => {
    const ical = Buffer.from('\r\n  begin:vcalendar\r\nVERSION:2.0\r\n');
    expect(detect_item_attachment_content_type(ical)).toBe('text/calendar');
  });
});

describe('item_attachment_filename', () => {
  it('adds the extension implied by the resolved type', () => {
    expect(item_attachment_filename('FW escalation', 'message/rfc822')).toBe('FW escalation.eml');
    expect(item_attachment_filename('Weekly sync', 'text/calendar')).toBe('Weekly sync.ics');
    expect(item_attachment_filename('Alice', 'text/vcard')).toBe('Alice.vcf');
  });

  it('does not double an extension the name already has', () => {
    expect(item_attachment_filename('thread.eml', 'message/rfc822')).toBe('thread.eml');
    expect(item_attachment_filename('thread.EML', 'message/rfc822')).toBe('thread.EML');
  });

  it('leaves a name alone for a type with no known extension', () => {
    expect(item_attachment_filename('mystery', 'application/octet-stream')).toBe('mystery');
  });
});

describe('resolve_downloaded_attachment', () => {
  it('resolves an item attachment type and filename from its bytes', () => {
    const [pending] = map_attachments([item_record]);
    const ical = Buffer.from('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n');

    const resolved = resolve_downloaded_attachment(pending!, ical);

    expect(resolved.content_type).toBe('text/calendar');
    expect(resolved.name).toBe('FW escalation.ics');
    expect(resolved.size_bytes).toBe(ical.length);
  });

  it('keeps the Graph-reported type for a file attachment', () => {
    const { contentBytes: _inline, ...needs_download } = file_record;
    const [pending] = map_attachments([needs_download]);
    const bytes = Buffer.from('%PDF-1.7 ...');

    const resolved = resolve_downloaded_attachment(pending!, bytes);

    expect(resolved.content_type).toBe('application/pdf');
    expect(resolved.name).toBe('report.pdf');
    expect(resolved.size_bytes).toBe(bytes.length);
  });

  it('records the real byte length rather than the size Graph reported', () => {
    const [pending] = map_attachments([item_record]);
    const bytes = Buffer.from('From: a@b.com\r\n\r\nshort');

    expect(pending?.size_bytes).toBe(4096);
    expect(resolve_downloaded_attachment(pending!, bytes).size_bytes).toBe(bytes.length);
  });
});
