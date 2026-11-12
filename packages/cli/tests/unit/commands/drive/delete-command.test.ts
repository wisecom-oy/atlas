import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import {
  ONEDRIVE_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  DELETION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { SnapshotNotNewestError, type DeletionResult } from '@wisecom/atlas-types';
import { handle_fatal_error } from '@/fatal-error';
import { register_onedrive_command } from '@/commands/onedrive/onedrive.command';
import { register_sharepoint_command } from '@/commands/sharepoint/sharepoint.command';
import { register_tenant_delete_command } from '@/commands/tenant/delete.command';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { ask_confirmation, ask_exact_match } from '@/ui/components/confirm-prompt';

vi.mock('@/ui/components/confirm-prompt', () => ({
  ask_confirmation: vi.fn().mockResolvedValue(true),
  ask_exact_match: vi.fn().mockResolvedValue(true),
}));

const TENANT_ID = 'test-tenant';
const OWNER_EMAIL = 'user@example.com';
const OWNER_OBJECT_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Example';
const SITE_ID = '00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';

const RESULT: DeletionResult = {
  deleted_objects: 3,
  deleted_manifests: 1,
  retained_objects: 0,
  retained_manifests: 0,
  failed_objects: 0,
  failed_manifests: 0,
};

interface Harness {
  program: Command;
  onedrive: { delete_owner_data: Mock; delete_snapshot: Mock };
  sharepoint: { delete_site_data: Mock; delete_snapshot: Mock };
  outlook: { purge_tenant: Mock; delete_mailbox_data: Mock; delete_snapshot: Mock };
  resolve_user: Mock;
  resolve_site: Mock;
}

function harness(): Harness {
  const container = new Container();
  const onedrive = {
    delete_owner_data: vi.fn().mockResolvedValue(RESULT),
    delete_snapshot: vi.fn().mockResolvedValue(RESULT),
  };
  const sharepoint = {
    delete_site_data: vi.fn().mockResolvedValue(RESULT),
    delete_snapshot: vi.fn().mockResolvedValue(RESULT),
  };
  const outlook = {
    purge_tenant: vi.fn().mockResolvedValue(RESULT),
    delete_mailbox_data: vi.fn().mockResolvedValue(RESULT),
    delete_snapshot: vi.fn().mockResolvedValue(RESULT),
  };
  const resolve_user = vi.fn().mockResolvedValue({
    object_id: OWNER_OBJECT_ID,
    email: OWNER_EMAIL,
    display_name: 'Example User',
  });
  const resolve_site = vi.fn().mockResolvedValue({
    site_id: SITE_ID,
    site_url: SITE_URL,
    display_name: 'Example',
  });

  container.bind(ONEDRIVE_DELETION_USE_CASE_TOKEN).toConstantValue(onedrive);
  container.bind(SHAREPOINT_DELETION_USE_CASE_TOKEN).toConstantValue(sharepoint);
  container.bind(DELETION_USE_CASE_TOKEN).toConstantValue(outlook);
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user });
  container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({ resolve_site });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: TENANT_ID });

  const program = new Command();
  program.exitOverride();
  register_onedrive_command(program, () => container);
  register_sharepoint_command(program, () => container);
  register_tenant_delete_command(program, () => container);
  register_outlook_command(program, () => container);
  return { program, onedrive, sharepoint, outlook, resolve_user, resolve_site };
}

describe('drive deletion commands (issue #163)', () => {
  let h: Harness;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(ask_confirmation).mockClear();
    vi.mocked(ask_confirmation).mockResolvedValue(true);
    process.exitCode = undefined;
    h = harness();
  });

  it('deletes every OneDrive backup for the resolved owner object id, not the raw email', async () => {
    await h.program.parseAsync(['onedrive', 'delete', '-o', OWNER_EMAIL, '-y'], { from: 'user' });

    expect(h.resolve_user).toHaveBeenCalledWith(TENANT_ID, OWNER_EMAIL);
    expect(h.onedrive.delete_owner_data).toHaveBeenCalledWith(TENANT_ID, OWNER_OBJECT_ID);
    expect(h.onedrive.delete_snapshot).not.toHaveBeenCalled();
  });

  it('scopes OneDrive deletion to one snapshot when -s is given', async () => {
    await h.program.parseAsync(
      ['onedrive', 'delete', '-o', OWNER_OBJECT_ID, '-s', 'od-snap-1', '-y'],
      { from: 'user' },
    );

    expect(h.onedrive.delete_snapshot).toHaveBeenCalledWith(
      TENANT_ID,
      OWNER_OBJECT_ID,
      'od-snap-1',
    );
    expect(h.onedrive.delete_owner_data).not.toHaveBeenCalled();
  });

  it('deletes SharePoint data under the resolved composite site id', async () => {
    await h.program.parseAsync(['sharepoint', 'delete', '--site', SITE_URL, '-y'], {
      from: 'user',
    });

    expect(h.resolve_site).toHaveBeenCalledWith(TENANT_ID, SITE_URL);
    expect(h.sharepoint.delete_site_data).toHaveBeenCalledWith(TENANT_ID, SITE_ID);
  });

  it('scopes SharePoint deletion to one snapshot when -s is given', async () => {
    await h.program.parseAsync(
      ['sharepoint', 'delete', '--site', SITE_ID, '-s', 'sp-snap-1', '-y'],
      { from: 'user' },
    );

    expect(h.resolve_site).not.toHaveBeenCalled();
    expect(h.sharepoint.delete_snapshot).toHaveBeenCalledWith(TENANT_ID, SITE_ID, 'sp-snap-1');
  });

  // Issue #725: newer snapshots fold in what an older one recorded, so the service refuses to
  // delete it. The refusal has to reach the fatal handler as itself to get its own exit code.
  it.each([
    {
      workload: 'onedrive' as const,
      argv: ['onedrive', 'delete', '-o', OWNER_OBJECT_ID, '-s', 'od-snap-1', '-y'],
      wording: { owner: 'OneDrive', records: 'files', delete_all_flag: '-o' },
    },
    {
      workload: 'sharepoint' as const,
      argv: ['sharepoint', 'delete', '--site', SITE_ID, '-s', 'sp-snap-1', '-y'],
      wording: { owner: 'site', records: 'files', delete_all_flag: '--site' },
    },
  ])('exits 11 when $workload delete -s names an older snapshot', async (refused) => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
    const refusal = new SnapshotNotNewestError('snap-1', ['snap-2'], { wording: refused.wording });
    h[refused.workload].delete_snapshot.mockRejectedValue(refusal);

    const run = h.program.parseAsync(refused.argv, { from: 'user' });
    await expect(run).rejects.toBe(refusal);
    handle_fatal_error(refusal);

    expect(process.exitCode).toBe(11);
    expect(errors.join('\n')).toContain('Atlas code: ATLAS_SNAPSHOT_NOT_NEWEST');
    expect(errors.join('\n')).toContain(`whole ${refused.wording.owner} backup`);
  });

  it('deletes nothing when the operator declines the confirmation', async () => {
    vi.mocked(ask_confirmation).mockResolvedValue(false);
    vi.mocked(ask_exact_match).mockResolvedValue(false);

    await h.program.parseAsync(['onedrive', 'delete', '-o', OWNER_OBJECT_ID], { from: 'user' });
    await h.program.parseAsync(['sharepoint', 'delete', '--site', SITE_ID], { from: 'user' });
    await h.program.parseAsync(['delete', '--purge'], { from: 'user' });

    expect(h.onedrive.delete_owner_data).not.toHaveBeenCalled();
    expect(h.sharepoint.delete_site_data).not.toHaveBeenCalled();
    expect(h.outlook.purge_tenant).not.toHaveBeenCalled();
  });

  it('asks for confirmation before deleting when -y is absent', async () => {
    await h.program.parseAsync(['onedrive', 'delete', '-o', OWNER_OBJECT_ID], { from: 'user' });

    expect(ask_confirmation).toHaveBeenCalledTimes(1);
    expect(h.onedrive.delete_owner_data).toHaveBeenCalledWith(TENANT_ID, OWNER_OBJECT_ID);
  });
});

describe('tenant-wide purge moved out of the outlook group (issue #163)', () => {
  let h: Harness;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(ask_confirmation).mockClear();
    vi.mocked(ask_confirmation).mockResolvedValue(true);
    vi.mocked(ask_exact_match).mockClear();
    vi.mocked(ask_exact_match).mockResolvedValue(true);
    process.exitCode = undefined;
    h = harness();
  });

  it('purges the whole tenant from the top-level delete command', async () => {
    await h.program.parseAsync(['delete', '--purge', '-y'], { from: 'user' });

    expect(h.outlook.purge_tenant).toHaveBeenCalledWith(TENANT_ID);
  });

  it('refuses a bare delete rather than guessing a scope', async () => {
    await h.program.parseAsync(['delete'], { from: 'user' });

    expect(h.outlook.purge_tenant).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('no longer accepts --purge under outlook delete', async () => {
    await expect(
      h.program.parseAsync(['outlook', 'delete', '--purge', '-y'], { from: 'user' }),
    ).rejects.toThrow(/unknown option/);
    expect(h.outlook.purge_tenant).not.toHaveBeenCalled();
  });

  it('still deletes a single mailbox through outlook delete', async () => {
    await h.program.parseAsync(['outlook', 'delete', '-m', OWNER_EMAIL, '-y'], { from: 'user' });

    expect(h.outlook.delete_mailbox_data).toHaveBeenCalledWith(TENANT_ID, OWNER_OBJECT_ID);
  });

  it('purges only when the tenant ID is typed back exactly', async () => {
    vi.mocked(ask_exact_match).mockResolvedValue(false);
    await h.program.parseAsync(['delete', '--purge'], { from: 'user' });
    expect(h.outlook.purge_tenant).not.toHaveBeenCalled();

    vi.mocked(ask_exact_match).mockResolvedValue(true);
    await h.program.parseAsync(['delete', '--purge'], { from: 'user' });

    expect(ask_exact_match).toHaveBeenLastCalledWith(expect.any(String), TENANT_ID);
    expect(h.outlook.purge_tenant).toHaveBeenCalledWith(TENANT_ID);
  });

  it('never asks the operator to type anything when -y is given', async () => {
    await h.program.parseAsync(['delete', '--purge', '-y'], { from: 'user' });

    expect(ask_exact_match).not.toHaveBeenCalled();
    expect(ask_confirmation).not.toHaveBeenCalled();
    expect(h.outlook.purge_tenant).toHaveBeenCalledWith(TENANT_ID);
  });

  it('asks for the tenant ID against --tenant, not the configured tenant', async () => {
    await h.program.parseAsync(['delete', '--purge', '-t', 'other-tenant'], { from: 'user' });

    expect(ask_exact_match).toHaveBeenLastCalledWith(expect.any(String), 'other-tenant');
    expect(h.outlook.purge_tenant).toHaveBeenCalledWith('other-tenant');
  });
});
