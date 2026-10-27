import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import {
  SHAREPOINT_CATALOG_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { register_sharepoint_command } from '@/commands/sharepoint.command';

/**
 * Commands that read stored backups must reach a site by its id without asking Graph. A site that
 * was deleted from SharePoint is exactly the one whose backups an operator needs, and Graph answers
 * 404 for it.
 */
const TENANT_ID = 'test-tenant';
const SITE_ID = '00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';
const WITH_HOST = `contoso.sharepoint.com,${SITE_ID}`;

interface Harness {
  program: Command;
  resolve_site: Mock;
  save_snapshot: Mock;
  verify_sharepoint_snapshot: Mock;
  list_sharepoint_snapshots: Mock;
}

function harness(): Harness {
  const container = new Container();
  const resolve_site = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('404'), { statusCode: 404 }));
  const save_snapshot = vi.fn().mockResolvedValue({
    snapshot_id: 'sp-snap-1',
    files_saved: 1,
    files_skipped: [],
    integrity_failures: [],
    errors: [],
    total_bytes: 1,
    output_path: 'out.zip',
  });
  const verify_sharepoint_snapshot = vi
    .fn()
    .mockResolvedValue({ total_checked: 1, failed_file_ids: [], index_issues: [] });
  const list_sharepoint_snapshots = vi.fn().mockResolvedValue([]);

  container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({ resolve_site });
  container.bind(SHAREPOINT_SAVE_USE_CASE_TOKEN).toConstantValue({ save_snapshot });
  container
    .bind(SHAREPOINT_VERIFICATION_USE_CASE_TOKEN)
    .toConstantValue({ verify_sharepoint_snapshot });
  container.bind(SHAREPOINT_CATALOG_USE_CASE_TOKEN).toConstantValue({ list_sharepoint_snapshots });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: TENANT_ID });

  const program = new Command();
  program.exitOverride();
  register_sharepoint_command(program, () => container);
  return {
    program,
    resolve_site,
    save_snapshot,
    verify_sharepoint_snapshot,
    list_sharepoint_snapshots,
  };
}

describe('SharePoint read commands with a site id that Graph no longer knows', () => {
  let h: Harness;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h = harness();
  });

  it('saves a snapshot without contacting Graph', async () => {
    await h.program.parseAsync(['sharepoint', 'save', '--site', WITH_HOST, '-s', 'sp-snap-1'], {
      from: 'user',
    });

    expect(h.resolve_site).not.toHaveBeenCalled();
    expect(h.save_snapshot.mock.calls[0]![1]).toBe(SITE_ID);
  });

  it('verifies a snapshot without contacting Graph', async () => {
    await h.program.parseAsync(['sharepoint', 'verify', '--site', SITE_ID, '-s', 'sp-snap-1'], {
      from: 'user',
    });

    expect(h.resolve_site).not.toHaveBeenCalled();
    expect(h.verify_sharepoint_snapshot).toHaveBeenCalledWith(TENANT_ID, SITE_ID, 'sp-snap-1');
  });

  it('lists snapshots without contacting Graph', async () => {
    await h.program.parseAsync(['sharepoint', 'list-snapshots', '--site', WITH_HOST], {
      from: 'user',
    });

    expect(h.resolve_site).not.toHaveBeenCalled();
    expect(h.list_sharepoint_snapshots).toHaveBeenCalledWith(TENANT_ID, SITE_ID);
  });
});
