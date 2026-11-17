import { describe, expect, it, vi } from 'vitest';
import { MAX_HOSTED_RECHECK_ATTEMPTS } from '@/services/backup/hosted-recheck';
import { CHANNEL_WITH_EMAIL } from './channel-backup-processor-harness';
import { build_env, root, stored_cursor, TEAM, TENANT } from './backup.service-storage-harness';
import { hosted_body, message } from './thread-store-harness';

/** A root whose body references hosted item h1, which the test connector cannot download. */
const HOSTED_ROOT = message('m1', {
  body: { contentType: 'html', content: hosted_body('m1', 'h1') },
});

/** Connector overrides for a root whose hosted item stays missing on every run. */
function missing_hosted_overrides() {
  return {
    list_channel_messages_page: vi.fn(async () => ({ roots: [root(HOSTED_ROOT)] })),
    fetch_message_delta_page: vi.fn(async () => ({ roots: [], delta_link: 'link-next' })),
    list_hosted_contents: vi.fn(async () => [{ id: 'h1' }]),
    download_hosted_content: vi.fn(async () => {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    }),
  };
}

describe('hosted content recheck over several runs (Q1, Q2)', () => {
  it('stops re-fetching a root whose re-read keeps returning 404 after the limit', async () => {
    const overrides = missing_hosted_overrides();
    const get_channel_message = vi.fn(async () => ({ status: 'not_found' as const }));
    const env = build_env(CHANNEL_WITH_EMAIL, { ...overrides, get_channel_message });

    const fetches_after_each_run: number[] = [];
    for (let run = 1; run <= MAX_HOSTED_RECHECK_ATTEMPTS + 2; run++) {
      await env.service.backup_team(TENANT, TEAM);
      fetches_after_each_run.push(get_channel_message.mock.calls.length);
    }

    expect(fetches_after_each_run).toEqual([0, 1, 2, 3, 4, 4, 4]);
    expect((await stored_cursor(env))?.hosted_recheck).toEqual({
      m1: MAX_HOSTED_RECHECK_ATTEMPTS,
    });
    expect((await stored_cursor(env))?.failed_roots ?? {}).toEqual({});
  });

  it('keeps the recheck limit on full-read runs and warns about giving up once', async () => {
    const env = build_env(CHANNEL_WITH_EMAIL, missing_hosted_overrides());

    const attempts_after_each_run: Array<number | undefined> = [];
    let gave_up_warnings = 0;
    for (let run = 1; run <= MAX_HOSTED_RECHECK_ATTEMPTS + 2; run++) {
      const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });
      attempts_after_each_run.push((await stored_cursor(env))?.hosted_recheck?.m1);
      gave_up_warnings += result.summary.warnings.filter((w) =>
        w.includes('gave up re-checking'),
      ).length;
    }

    expect(attempts_after_each_run).toEqual([1, 2, 3, 4, 5, 5, 5]);
    expect(gave_up_warnings).toBe(1);
  });
});
