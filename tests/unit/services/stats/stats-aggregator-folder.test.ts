import { describe, it, expect } from 'vitest';
import { aggregate_folder_stats } from '@/services/stats/stats-aggregator';
import { make_entry } from './stats-aggregator.fixtures';

describe('aggregate_folder_stats', () => {
  it('returns empty array for no entries', () => {
    expect(aggregate_folder_stats([])).toEqual([]);
  });

  it('groups entries by folder and accumulates sizes', () => {
    const entries = [
      make_entry({
        folder_id: 'inbox',
        size_bytes: 100,
        attachments: [
          {
            attachment_id: 'a1',
            name: 'f.txt',
            content_type: 'text/plain',
            size_bytes: 50,
            storage_key: 'att/a',
            checksum: 'a',
            is_inline: false,
          },
        ],
      }),
      make_entry({ folder_id: 'inbox', size_bytes: 200 }),
      make_entry({ folder_id: 'sent', size_bytes: 300 }),
    ];

    const result = aggregate_folder_stats(entries);

    expect(result).toHaveLength(2);
    const inbox = result.find((f) => f.folder_id === 'inbox')!;
    expect(inbox.message_count).toBe(2);
    expect(inbox.total_size_bytes).toBe(100 + 50 + 200);
    expect(inbox.attachment_count).toBe(1);
    expect(inbox.attachment_size_bytes).toBe(50);

    const sent = result.find((f) => f.folder_id === 'sent')!;
    expect(sent.message_count).toBe(1);
    expect(sent.total_size_bytes).toBe(300);
    expect(sent.attachment_count).toBe(0);
  });
});
