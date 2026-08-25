import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import {
  ONEDRIVE_STATUS_USE_CASE_TOKEN,
  SHAREPOINT_STATUS_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { register_onedrive_command } from '@/commands/onedrive.command';
import { register_sharepoint_command } from '@/commands/sharepoint.command';

const TENANT_ID = 'test-tenant';
const OWNER_EMAIL = 'user@example.com';
const OWNER_OBJECT_ID = '75a21b57-4d82-4f42-9ccc-7c231c30f78c';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Example';
const SITE_ID = `contoso.sharepoint.com,${OWNER_OBJECT_ID},11111111-1111-1111-1111-111111111111`;

const ONEDRIVE_STATUS = {
  owner_id: OWNER_OBJECT_ID,
  last_backup_at: new Date('2026-08-01T10:00:00Z'),
  last_snapshot_id: 'od-snap-1',
  total_drives: 2,
  drives: [
    {
      drive_id: 'd1',
      drive_name: 'OneDrive',
      has_backup: true,
      pending_changes: 4,
      is_up_to_date: false,
    },
    {
      drive_id: 'd2',
      drive_name: 'Archive',
      has_backup: false,
      pending_changes: 0,
      is_up_to_date: false,
    },
  ],
  is_up_to_date: false,
  total_pending_changes: 4,
};

const SHAREPOINT_STATUS = {
  site_id: SITE_ID,
  last_backup_at: undefined,
  last_snapshot_id: undefined,
  total_libraries: 1,
  libraries: [
    {
      drive_id: 'l1',
      drive_name: 'Documents',
      has_backup: false,
      pending_changes: 0,
      is_up_to_date: false,
    },
  ],
  is_up_to_date: false,
  total_pending_changes: 0,
};

interface Harness {
  program: Command;
  check_onedrive_status: Mock;
  check_sharepoint_status: Mock;
  resolve_user: Mock;
  resolve_site: Mock;
}

function harness(): Harness {
  const container = new Container();
  const check_onedrive_status = vi.fn().mockResolvedValue(ONEDRIVE_STATUS);
  const check_sharepoint_status = vi.fn().mockResolvedValue(SHAREPOINT_STATUS);
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

  container.bind(ONEDRIVE_STATUS_USE_CASE_TOKEN).toConstantValue({ check_onedrive_status });
  container.bind(SHAREPOINT_STATUS_USE_CASE_TOKEN).toConstantValue({ check_sharepoint_status });
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user });
  container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({ resolve_site });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: TENANT_ID });

  const program = new Command();
  program.exitOverride();
  register_onedrive_command(program, () => container);
  register_sharepoint_command(program, () => container);
  return { program, check_onedrive_status, check_sharepoint_status, resolve_user, resolve_site };
}

describe('drive status commands (issue #163)', () => {
  let h: Harness;
  let output: string[];

  beforeEach(() => {
    output = [];
    const capture = (...args: unknown[]): void => {
      output.push(args.join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    h = harness();
  });

  it('checks OneDrive status under the resolved owner object id', async () => {
    await h.program.parseAsync(['onedrive', 'status', '-o', OWNER_EMAIL], { from: 'user' });

    expect(h.resolve_user).toHaveBeenCalledWith(TENANT_ID, OWNER_EMAIL);
    expect(h.check_onedrive_status).toHaveBeenCalledWith(TENANT_ID, OWNER_OBJECT_ID);
  });

  it('reports the last snapshot and the overall pending verdict', async () => {
    await h.program.parseAsync(['onedrive', 'status', '-o', OWNER_OBJECT_ID], { from: 'user' });

    const text = output.join('\n');
    expect(text).toContain('od-snap-1');
    expect(text).toContain('4 pending change(s)');
    expect(text).toContain('1 drive(s) never backed up');
  });

  it('checks SharePoint status under the resolved composite site id', async () => {
    await h.program.parseAsync(['sharepoint', 'status', '--site', SITE_URL], { from: 'user' });

    expect(h.resolve_site).toHaveBeenCalledWith(TENANT_ID, SITE_URL);
    expect(h.check_sharepoint_status).toHaveBeenCalledWith(TENANT_ID, SITE_ID);
  });

  it('warns when a site has never been backed up', async () => {
    await h.program.parseAsync(['sharepoint', 'status', '--site', SITE_ID], { from: 'user' });

    expect(h.resolve_site).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('No previous backup found for this site.');
  });
});
