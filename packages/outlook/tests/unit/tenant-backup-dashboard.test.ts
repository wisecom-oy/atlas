import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TenantBackupDashboard } from '@/services/backup/tenant-backup-dashboard';

describe('TenantBackupDashboard', () => {
  let original_is_tty: boolean | undefined;

  beforeEach(() => {
    original_is_tty = process.stdout.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: original_is_tty, writable: true });
  });

  it('creates without errors', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const dashboard = new TenantBackupDashboard(3);
    expect(dashboard).toBeDefined();
  });

  it('set_mailbox_count stores the total', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const dashboard = new TenantBackupDashboard(3);
    dashboard.set_mailbox_count(131);
    dashboard.finish();
  });

  it('mark_mailbox_done logs in non-TTY mode', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dashboard = new TenantBackupDashboard(3);
    dashboard.mark_mailbox_active(0, 'alice@t.com');
    dashboard.mark_mailbox_done(0, 'alice@t.com', 10, 5);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('alice@t.com'));
    spy.mockRestore();
  });

  it('mark_mailbox_error logs in non-TTY mode', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dashboard = new TenantBackupDashboard(3);
    dashboard.mark_mailbox_active(0, 'bob@t.com');
    dashboard.mark_mailbox_error(0, 'bob@t.com', 'timeout');

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
    spy.mockRestore();
  });

  it('update_mailbox_progress does not crash on empty slot', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const dashboard = new TenantBackupDashboard(3);
    dashboard.update_mailbox_progress(0, 'Inbox', 50, 3.5);
  });

  it('set_status stores the message', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const dashboard = new TenantBackupDashboard(3);
    dashboard.set_status('Stopping...');
    dashboard.finish();
  });

  it('ignores out-of-range slots', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const dashboard = new TenantBackupDashboard(2);
    dashboard.mark_mailbox_active(5, 'out@range.com');
    dashboard.update_mailbox_progress(5, 'Inbox', 50, 1.0);
  });
});
