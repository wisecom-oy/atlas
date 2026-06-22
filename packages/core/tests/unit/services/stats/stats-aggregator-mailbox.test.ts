import { describe, it, expect } from 'vitest';
import { aggregate_mailbox_stats } from '@/services/stats/stats-aggregator';
import { make_entry, make_manifest } from './stats-aggregator.fixtures';

describe('aggregate_mailbox_stats', () => {
  it('returns zeroed stats for empty manifests', () => {
    const result = aggregate_mailbox_stats('user@test.com', []);

    expect(result.owner_id).toBe('user@test.com');
    expect(result.snapshot_count).toBe(0);
    expect(result.total_messages).toBe(0);
    expect(result.total_size_bytes).toBe(0);
    expect(result.attachment_count).toBe(0);
    expect(result.attachment_size_bytes).toBe(0);
    expect(result.folders).toEqual([]);
    expect(result.monthly_breakdown).toEqual([]);
  });

  it('aggregates messages and attachments across snapshots', () => {
    const manifests = [
      make_manifest({
        entries: [
          make_entry({
            size_bytes: 200,
            folder_id: 'inbox',
            attachments: [
              {
                attachment_id: 'a1',
                name: 'f.pdf',
                content_type: 'application/pdf',
                size_bytes: 100,
                storage_key: 'att/x',
                checksum: 'x',
                is_inline: false,
              },
            ],
          }),
        ],
      }),
      make_manifest({
        entries: [make_entry({ size_bytes: 300, folder_id: 'sent' })],
      }),
    ];

    const result = aggregate_mailbox_stats('user@test.com', manifests);

    expect(result.snapshot_count).toBe(2);
    expect(result.total_messages).toBe(2);
    expect(result.total_size_bytes).toBe(200 + 100 + 300);
    expect(result.attachment_count).toBe(1);
    expect(result.attachment_size_bytes).toBe(100);
  });

  it('groups entries by folder_id', () => {
    const manifests = [
      make_manifest({
        entries: [
          make_entry({ size_bytes: 100, folder_id: 'inbox' }),
          make_entry({ size_bytes: 200, folder_id: 'sent' }),
          make_entry({ size_bytes: 150, folder_id: 'inbox' }),
        ],
      }),
    ];

    const result = aggregate_mailbox_stats('user@test.com', manifests);

    expect(result.folders).toHaveLength(2);
    const inbox = result.folders.find((f) => f.folder_id === 'inbox')!;
    expect(inbox.message_count).toBe(2);
    expect(inbox.total_size_bytes).toBe(250);

    const sent = result.folders.find((f) => f.folder_id === 'sent')!;
    expect(sent.message_count).toBe(1);
    expect(sent.total_size_bytes).toBe(200);
  });

  it('assigns "unknown" folder_id when entry has no folder_id', () => {
    const manifests = [
      make_manifest({
        entries: [make_entry({ size_bytes: 100 })],
      }),
    ];

    const result = aggregate_mailbox_stats('user@test.com', manifests);

    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]!.folder_id).toBe('unknown');
  });

  it('sorts folders alphabetically', () => {
    const manifests = [
      make_manifest({
        entries: [
          make_entry({ folder_id: 'sent' }),
          make_entry({ folder_id: 'archive' }),
          make_entry({ folder_id: 'inbox' }),
        ],
      }),
    ];

    const result = aggregate_mailbox_stats('user@test.com', manifests);

    expect(result.folders.map((f) => f.folder_id)).toEqual(['archive', 'inbox', 'sent']);
  });
});
