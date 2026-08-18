import { describe, it, expect, vi, afterEach } from 'vitest';
import { BackupProgressLineReporter } from '@/ui/dashboards/backup-progress-line-reporter';
import { TenantBackupLineReporter } from '@/ui/dashboards/tenant-backup-line-reporter';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BackupProgressLineReporter', () => {
  const folders = [
    { name: 'Inbox', total_items: 100 },
    { name: 'Drafts', total_items: 0 },
  ];

  it('logs pre-Ink-compatible lines for done, synced, and empty folders', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reporter = new BackupProgressLineReporter(folders);

    reporter.update_active(0, 10, 1, 0);
    reporter.mark_done(0, 8, 2, 0);
    reporter.mark_done(1, 0, 0, 0);

    expect(spy).toHaveBeenCalledWith('  [ok] Inbox -- 8 stored, 2 dedup');
    expect(spy).toHaveBeenCalledWith('  [--] Drafts -- 0 items -- empty');
  });

  it('logs interruption only for non-terminal folders', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reporter = new BackupProgressLineReporter(folders);

    reporter.mark_error(0, 'timeout');
    reporter.mark_all_pending_interrupted();

    expect(spy).toHaveBeenCalledWith('  [!!] Inbox -- ERROR: timeout');
    expect(spy).toHaveBeenCalledWith('  [~~] Drafts -- interrupted');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('TenantBackupLineReporter', () => {
  it('logs one line per completed or failed mailbox', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reporter = new TenantBackupLineReporter();

    reporter.mark_mailbox_done(0, 'alice@t.com', 10, 5);
    reporter.mark_mailbox_error(1, 'bob@t.com', 'timeout');

    expect(spy).toHaveBeenCalledWith('  [ok] alice@t.com -- 10 stored, 5 dedup');
    expect(spy).toHaveBeenCalledWith('  [!!] bob@t.com -- ERROR: timeout');
  });
});
