import { describe, it, expect } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import { TenantBackupStore } from '@/ui/dashboards/tenant-backup-store';
import { TenantBackupView } from '@/ui/dashboards/tenant-backup';

function mount(store: TenantBackupStore) {
  return render(<TenantBackupView store={store} />);
}

describe('TenantBackupView', () => {
  it('renders header, empty slots, and totals', async () => {
    const store = new TenantBackupStore(3);
    const { lastFrame } = mount(store);
    store.set_mailbox_count(131);
    await sleep(0);
    const frame = lastFrame()!;
    expect(frame).toContain('Atlas Tenant Backup -- 0/131 mailboxes');
    expect(frame.match(/\[ {2}\] --/g)).toHaveLength(3);
    expect(frame).toContain('131 pending');
  });

  it('shows active mailbox slots with folder and rate', async () => {
    const store = new TenantBackupStore(2);
    const { lastFrame } = mount(store);
    store.mark_mailbox_active(0, 'alice@contoso.com');
    store.update_mailbox_progress(0, 'Inbox', 50, 3.5);
    await sleep(0);
    const frame = lastFrame()!;
    expect(frame).toContain('[>>] alice@contoso.com');
    expect(frame).toContain('Inbox 50%');
    expect(frame).toContain('3.5 msg/s');
  });

  it('clears the slot when a mailbox finishes', async () => {
    const store = new TenantBackupStore(2);
    const { lastFrame } = mount(store);
    store.mark_mailbox_active(0, 'alice@contoso.com');
    store.mark_mailbox_done(0, 'alice@contoso.com', 10, 5);
    store.update_totals(1, 0, 4, 2.0, 60);
    await sleep(0);
    const frame = lastFrame()!;
    expect(frame).not.toContain('alice@contoso.com');
    expect(frame).toContain('[ok] 1 done');
    expect(frame).toContain('4 pending');
  });

  it('surfaces error counts in the summary footer', async () => {
    const store = new TenantBackupStore(2);
    const { lastFrame } = mount(store);
    store.mark_mailbox_active(0, 'bob@contoso.com');
    store.mark_mailbox_error(0, 'bob@contoso.com', 'timeout');
    store.update_totals(0, 1, 3, 0, 0);
    await sleep(0);
    expect(lastFrame()).toContain('[!!] 1 error');
  });

  it('ignores out-of-range slots', async () => {
    const store = new TenantBackupStore(2);
    const { lastFrame } = mount(store);
    store.mark_mailbox_active(5, 'out@range.com');
    store.update_mailbox_progress(5, 'Inbox', 50, 1.0);
    await sleep(0);
    expect(lastFrame()).not.toContain('out@range.com');
  });

  it('renders the interrupt status message', async () => {
    const store = new TenantBackupStore(2);
    const { lastFrame } = mount(store);
    store.set_status('[!] Stopping -- finishing active mailboxes');
    await sleep(0);
    expect(lastFrame()).toContain('[!] Stopping');
  });
});
