import { describe, it, expect } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import { TransferProgressStore } from '@/ui/dashboards/transfer-progress-store';
import { TransferProgressView } from '@/ui/dashboards/transfer-progress';

const FOLDERS = [
  { name: 'Inbox', total_items: 10 },
  { name: 'Archive', total_items: 0 },
];

describe('TransferProgressView', () => {
  it('renders saved rows with integrity failures', async () => {
    const store = new TransferProgressStore(FOLDERS);
    const { lastFrame } = render(<TransferProgressView store={store} verb="saved" />);
    store.mark_active(0);
    store.update_active(0, {
      transferred: 5,
      attachments: 2,
      integrity_fail: 1,
      rate: 2.5,
      eta_seconds: 2,
    });
    await sleep(0);
    expect(lastFrame()).toContain('5/10');
    expect(lastFrame()).toContain('1!');
    store.mark_done(0, 9, 2);
    store.mark_done(1, 0, 0);
    await sleep(0);
    expect(lastFrame()).toContain('9 saved, 2 att');
    expect(lastFrame()).toContain('[--] Archive');
    expect(lastFrame()).toContain('skipped');
  });

  it('uses the restored verb and shows finalizing state', async () => {
    const store = new TransferProgressStore(FOLDERS);
    const { lastFrame } = render(<TransferProgressView store={store} verb="restored" />);
    store.mark_done(0, 7, 0);
    store.update_total(7, 10, 3.0, 1);
    store.show_finalizing();
    await sleep(0);
    expect(lastFrame()).toContain('7 restored');
    expect(lastFrame()).toContain('finalizing...');
    store.finish(10);
    await sleep(0);
    expect(lastFrame()).toContain('10/10');
  });
});
