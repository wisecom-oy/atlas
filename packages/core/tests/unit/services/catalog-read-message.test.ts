import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import type { CatalogService } from '@/services/catalog/catalog.service';
import type { ManifestRepository, TenantContext } from '@wisecom/atlas-types';
import { build_catalog_harness, make_manifest, stub_storage_get } from './catalog-service.fixtures';

describe('CatalogService.read_message', () => {
  let service: CatalogService;
  let mock_manifests: ManifestRepository;
  let mock_context: TenantContext;

  beforeEach(() => {
    ({ service, mock_manifests, mock_context } = build_catalog_harness());
  });

  it('decrypts and parses a stored JSON message with empty attachments', async () => {
    const message_json = { subject: 'Hello', body: { content: 'World' } };
    const plaintext = Buffer.from(JSON.stringify(message_json));
    const ciphertext = Buffer.concat([Buffer.from('E'), plaintext]);

    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest({
        entries: [
          { object_id: 'msg-1', storage_key: 'data/u/abc', checksum: 'abc', size_bytes: 100 },
        ],
      }),
    );
    stub_storage_get(mock_context, ciphertext);

    const result = await service.read_message('t', 'snap-1', 'msg-1');

    expect(result?.message).toEqual(message_json);
    expect(result?.raw).toEqual(plaintext);
    expect(result?.payload_format).toBeUndefined();
    expect(result?.attachments).toEqual([]);
    expect(mock_context.storage.get).toHaveBeenCalledWith('data/u/abc');
    expect(mock_context.decrypt).toHaveBeenCalledWith(ciphertext);
  });

  it('returns attachment metadata from a JSON manifest entry', async () => {
    const plaintext = Buffer.from(JSON.stringify({ subject: 'With PDF' }));
    const ciphertext = Buffer.concat([Buffer.from('E'), plaintext]);

    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest({
        entries: [
          {
            object_id: 'msg-1',
            storage_key: 'data/u/abc',
            checksum: 'abc',
            size_bytes: 100,
            attachments: [
              {
                attachment_id: 'att-1',
                name: 'report.pdf',
                content_type: 'application/pdf',
                size_bytes: 2048,
                storage_key: 'attachments/u/sha',
                checksum: 'sha',
                is_inline: false,
              },
            ],
          },
        ],
      }),
    );
    stub_storage_get(mock_context, ciphertext);

    const result = await service.read_message('t', 'snap-1', 'msg-1');

    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments[0]?.name).toBe('report.pdf');
  });

  it('returns raw MIME bytes without parsing for a mime entry', async () => {
    const mime = Buffer.from(
      'Received: from mail.test.com\r\nAuthentication-Results: spf=pass\r\n' +
        'Subject: Hello\r\n\r\nBody text\r\n',
    );
    const ciphertext = Buffer.concat([Buffer.from('E'), mime]);

    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest({
        entries: [
          {
            object_id: 'msg-mime',
            storage_key: 'data/u/mime',
            checksum: 'mime',
            size_bytes: mime.length,
            payload_format: 'mime',
          },
        ],
      }),
    );
    stub_storage_get(mock_context, ciphertext);

    const result = await service.read_message('t', 'snap-1', 'msg-mime');

    expect(result?.payload_format).toBe('mime');
    expect(result?.raw).toEqual(mime);
    expect(result?.message).toBeUndefined();
    expect(result?.attachments).toEqual([]);
  });

  it('returns undefined when snapshot does not exist', async () => {
    const result = await service.read_message('t', 'missing', 'msg-1');
    expect(result).toBeUndefined();
  });

  it('returns undefined when message is not in manifest', async () => {
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(make_manifest({ entries: [] }));

    const result = await service.read_message('t', 'snap-1', 'no-such-msg');
    expect(result).toBeUndefined();
  });
});
