import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { build_object_lock_policy, build_object_lock_request } from '@/command-object-lock';
import { register_onedrive_command } from '@/commands/onedrive.command';
import { register_sharepoint_command } from '@/commands/sharepoint.command';

const TENANT_ID = 'test-tenant';
const OWNER_EMAIL = 'john.doe@example.com';
const OWNER_OBJECT_ID = '00000000-0000-0000-0000-000000000000';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Example';

const PAIRING_ERROR = /--lock-mode requires --retention-days/;
const INVALID_MODE_ERROR = /Invalid object lock mode "bogus"/;

describe('Object Lock flag validation (issue #186)', () => {
  it('rejects --lock-mode without --retention-days', () => {
    expect(() => build_object_lock_request({ lockMode: 'compliance' })).toThrow(PAIRING_ERROR);
    expect(() => build_object_lock_policy({ lockMode: 'compliance' })).toThrow(PAIRING_ERROR);
  });

  it('rejects an invalid --lock-mode whether or not retention was requested', () => {
    expect(() => build_object_lock_request({ lockMode: 'bogus' })).toThrow(INVALID_MODE_ERROR);
    expect(() => build_object_lock_request({ lockMode: 'bogus', retentionDays: '30' })).toThrow(
      INVALID_MODE_ERROR,
    );
    expect(() => build_object_lock_policy({ lockMode: 'bogus' })).toThrow(INVALID_MODE_ERROR);
  });

  it('keeps defaulting to GOVERNANCE when only --retention-days is given', () => {
    expect(build_object_lock_request({ retentionDays: '30' })).toEqual({
      mode: 'GOVERNANCE',
      retention_days: 30,
    });
    expect(build_object_lock_policy({ retentionDays: '30' })?.mode).toBe('GOVERNANCE');
  });

  it('still builds nothing when neither flag is given', () => {
    expect(build_object_lock_request({})).toBeUndefined();
    expect(build_object_lock_policy({})).toBeUndefined();
  });

  it('accepts a valid mode paired with retention', () => {
    expect(build_object_lock_request({ lockMode: 'compliance', retentionDays: '7' })).toEqual({
      mode: 'COMPLIANCE',
      retention_days: 7,
    });
  });
});

interface Harness {
  program: Command;
  backup_onedrive: Mock;
  backup_site_tree: Mock;
  resolve_user: Mock;
  resolve_site: Mock;
}

function harness(): Harness {
  const container = new Container();
  const backup_onedrive = vi.fn().mockResolvedValue({ summary: { errors: [], warnings: [] } });
  const backup_site_tree = vi.fn().mockResolvedValue([]);
  const resolve_user = vi.fn().mockResolvedValue({
    object_id: OWNER_OBJECT_ID,
    email: OWNER_EMAIL,
    display_name: 'John Doe',
  });
  const resolve_site = vi.fn().mockResolvedValue({
    site_id: `contoso.sharepoint.com,${OWNER_OBJECT_ID},${OWNER_OBJECT_ID}`,
    site_url: SITE_URL,
    display_name: 'Example',
  });

  container.bind(ONEDRIVE_BACKUP_USE_CASE_TOKEN).toConstantValue({ backup_onedrive });
  container.bind(SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN).toConstantValue({ backup_site_tree });
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user });
  container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({ resolve_site });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: TENANT_ID });

  const program = new Command();
  program.exitOverride();
  register_onedrive_command(program, () => container);
  register_sharepoint_command(program, () => container);
  return { program, backup_onedrive, backup_site_tree, resolve_user, resolve_site };
}

describe('drive backups reject bad Object Lock flags before reaching Graph (issue #186)', () => {
  let h: Harness;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h = harness();
  });

  it('fails a OneDrive backup without resolving the owner', async () => {
    await expect(
      h.program.parseAsync(['onedrive', 'backup', '-o', OWNER_EMAIL, '--lock-mode', 'compliance'], {
        from: 'user',
      }),
    ).rejects.toThrow(PAIRING_ERROR);

    expect(h.resolve_user).not.toHaveBeenCalled();
    expect(h.backup_onedrive).not.toHaveBeenCalled();
  });

  it('fails a SharePoint backup without resolving the site', async () => {
    await expect(
      h.program.parseAsync(['sharepoint', 'backup', '--site', SITE_URL, '--lock-mode', 'bogus'], {
        from: 'user',
      }),
    ).rejects.toThrow(INVALID_MODE_ERROR);

    expect(h.resolve_site).not.toHaveBeenCalled();
    expect(h.backup_site_tree).not.toHaveBeenCalled();
  });

  it('forwards a valid flag pair to the OneDrive use case', async () => {
    await h.program.parseAsync(
      [
        'onedrive',
        'backup',
        '-o',
        OWNER_EMAIL,
        '--retention-days',
        '30',
        '--lock-mode',
        'compliance',
      ],
      { from: 'user' },
    );

    expect(h.backup_onedrive.mock.calls[0]![2].object_lock_request).toEqual({
      mode: 'COMPLIANCE',
      retention_days: 30,
    });
  });
});
