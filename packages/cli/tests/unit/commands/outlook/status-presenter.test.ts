import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderStatus, MailboxStatusResult } from '@wisecom/atlas-types';
import { print_mailbox_status } from '@/commands/outlook/status-presenter';

function folder(overrides: Partial<FolderStatus>): FolderStatus {
  return {
    folder_id: 'f1',
    folder_name: 'Inbox',
    has_backup: true,
    pending_new: 0,
    pending_removed: 0,
    pending_capped: false,
    is_up_to_date: true,
    ...overrides,
  };
}

function result(folders: FolderStatus[]): MailboxStatusResult {
  return {
    owner_id: 'owner',
    last_backup_at: new Date('2026-08-01T10:00:00Z'),
    last_snapshot_id: 'snap-1',
    total_folders: folders.length,
    folders,
    is_up_to_date: folders.every((f) => f.is_up_to_date),
    total_pending_changes: folders.reduce((sum, f) => sum + f.pending_new + f.pending_removed, 0),
    pending_capped: folders.some((f) => f.pending_capped),
  };
}

describe('print_mailbox_status (issue #630)', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    const capture = (...args: unknown[]): void => {
      output.push(args.join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
  });

  it('marks a capped count as a lower bound', async () => {
    await print_mailbox_status(
      result([folder({ pending_new: 250, pending_capped: true, is_up_to_date: false })]),
    );

    expect(output.join('\n')).toContain('250+ pending change(s)');
  });

  it('shows a failed peek as an error, not as pending changes', async () => {
    await print_mailbox_status(
      result([folder({ is_up_to_date: false, peek_error: 'ThrottledError: budget exhausted' })]),
    );

    const text = output.join('\n');
    expect(text).toContain('Inbox: ThrottledError: budget exhausted');
    expect(text).toContain('1 folder(s) could not be checked');
    expect(text).not.toContain('pending change(s)');
  });
});
