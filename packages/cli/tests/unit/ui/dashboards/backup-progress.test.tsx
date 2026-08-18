import { describe, it, expect } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import { BackupProgressStore } from '@/ui/dashboards/backup-progress-store';
import { BackupProgressView } from '@/ui/dashboards/backup-progress';

const FOLDERS = [
  { name: 'Inbox', total_items: 100 },
  { name: 'Sent Items', total_items: 50 },
  { name: 'Drafts', total_items: 0 },
];

function mount(store: BackupProgressStore) {
  return render(<BackupProgressView store={store} />);
}

describe('BackupProgressView', () => {
  it('aggregates pending folders and shows an empty TOTAL initially', async () => {
    const store = new BackupProgressStore(FOLDERS);
    const { lastFrame } = mount(store);
    expect(lastFrame()).toContain('3 folder(s) pending');
    expect(lastFrame()).toContain('---- TOTAL');
  });

  it('renders an active folder with rate and ETA', async () => {
    const store = new BackupProgressStore(FOLDERS);
    const { lastFrame } = mount(store);
    store.mark_active(0);
    store.update_active(0, 42, 3.5, 17);
    await sleep(0);
    expect(lastFrame()).toContain('[>>] Inbox');
    expect(lastFrame()).toContain('42/100');
    expect(lastFrame()).toContain('3.5 msg/s');
    expect(lastFrame()).toContain('ETA');
  });

  it('renders paging progress with items/s', async () => {
    const store = new BackupProgressStore(FOLDERS);
    const { lastFrame } = mount(store);
    store.mark_active(0);
    store.update_paging(0, 30, 12.0, 6);
    await sleep(0);
    expect(lastFrame()).toContain('fetching 30/100');
    expect(lastFrame()).toContain('12.0 items/s');
  });

  it('classifies finished folders as done, synced, or empty', async () => {
    const store = new BackupProgressStore(FOLDERS);
    const { lastFrame } = mount(store);
    store.mark_active(0);
    store.update_active(0, 10, 1, 0);
    store.mark_done(0, 8, 2, 1);
    store.mark_done(1, 0, 0, 0);
    store.mark_done(2, 0, 0, 0);
    await sleep(0);
    const frame = lastFrame()!;
    expect(frame).toContain('[ok] Inbox');
    expect(frame).toContain('8 stored, 2 dedup, 1 att');
    expect(frame).toContain('[==] Sent Items');
    expect(frame).toContain('up to date');
    expect(frame).toContain('[--] Drafts');
    expect(frame).toContain('empty');
  });

  it('marks remaining folders interrupted and shows the status line', async () => {
    const store = new BackupProgressStore(FOLDERS);
    const { lastFrame } = mount(store);
    store.mark_active(0);
    store.set_status('[!] Stopping -- finishing page fetch');
    store.mark_all_pending_interrupted();
    await sleep(0);
    const frame = lastFrame()!;
    expect(frame).toMatch(/\[~~\] Inbox\s+-- interrupted/);
    expect(frame).toMatch(/\[~~\] Drafts\s+-- interrupted/);
    expect(frame).toContain('[!] Stopping');
  });

  it('renders folder errors', async () => {
    const store = new BackupProgressStore(FOLDERS);
    const { lastFrame } = mount(store);
    store.mark_error(1, 'timeout');
    await sleep(0);
    expect(lastFrame()).toContain('[!!] Sent Items');
    expect(lastFrame()).toContain('ERROR: timeout');
  });

  it('finish() reconciles the TOTAL row to the actual count', async () => {
    const store = new BackupProgressStore(FOLDERS);
    const { lastFrame } = mount(store);
    store.update_total(10, 150, 2.0, 70);
    store.finish(150);
    await sleep(0);
    expect(lastFrame()).toContain('150/150');
    expect(lastFrame()).toContain('done');
  });

  it('supports OneDrive-style rows: unknown totals, set_row_total, custom units', async () => {
    const store = new BackupProgressStore([
      { name: 'Documents', total_items: 0 },
      { name: 'SitePages', total_items: 0 },
      { name: 'CacheLibrary', total_items: 0 },
    ]);
    const { lastFrame } = render(
      <BackupProgressView
        store={store}
        units={{ rate: 'files/s', extra: 'ver', row_noun: 'drive' }}
      />,
    );

    store.update_paging(0, 0, 0, 0);
    await sleep(0);
    expect(lastFrame()).toContain('[>>] Documents');
    expect(lastFrame()).toContain('fetching changes...');
    expect(lastFrame()).toContain('2 drive(s) pending');

    store.set_row_total(0, 131);
    store.mark_active(0);
    store.update_active(0, 40, 2.5, 36);
    await sleep(0);
    expect(lastFrame()).toContain('40/131');
    expect(lastFrame()).toContain('2.5 files/s');

    store.mark_done(0, 128, 3, 18);
    store.mark_synced(1);
    await sleep(0);
    expect(lastFrame()).toContain('128 stored, 3 dedup, 18 ver');
    expect(lastFrame()).toMatch(/\[==\] SitePages\s+-- up to date/);
  });
});
