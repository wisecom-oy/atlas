/**
 * Issue #623: the owner lease only protects an owner when every operation that writes its state
 * takes the same lease. This resolves each of them from the real SDK container and checks they
 * were handed the one storage-backed lease port, not a stand-in.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_USE_CASE_TOKEN,
  CALENDAR_DELETION_USE_CASE_TOKEN,
  CALENDAR_QUARANTINE_USE_CASE_TOKEN,
  CONTACTS_DELETION_USE_CASE_TOKEN,
  CONTACTS_QUARANTINE_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  ONEDRIVE_DELETION_USE_CASE_TOKEN,
  ONEDRIVE_QUARANTINE_USE_CASE_TOKEN,
  OUTLOOK_QUARANTINE_USE_CASE_TOKEN,
  OWNER_LEASE_TOKEN,
  ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_QUARANTINE_USE_CASE_TOKEN,
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_DELETION_USE_CASE_TOKEN,
  TEAMS_QUARANTINE_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import type { AtlasInstanceConfig } from '@wisecom/atlas-types';
import { StorageOwnerLeases } from '@wisecom/atlas-core/services/lease/storage-owner-leases';
import { CalendarBackupService } from '@wisecom/atlas-calendar';
import { ContactsBackupService } from '@wisecom/atlas-contacts';
import { OneDriveBackupService } from '@wisecom/atlas-onedrive';
import { SharePointBackupService } from '@wisecom/atlas-sharepoint';
import { create_container_from_config } from '@/container';
import { normalize_config } from '@/instance-config';

const config: AtlasInstanceConfig = {
  tenantId: randomUUID(),
  clientId: randomUUID(),
  clientSecret: '<redacted>',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: '<redacted>',
  s3SecretKey: '<redacted>',
  encryptionPassphrase: '<redacted>'.repeat(2),
};

const LEASE_TAKERS: readonly (readonly [string, symbol | (new (...args: never[]) => object)])[] = [
  ['Outlook backup', BACKUP_USE_CASE_TOKEN],
  ['OneDrive backup', OneDriveBackupService],
  ['SharePoint backup', SharePointBackupService],
  ['contacts backup', ContactsBackupService],
  ['calendar backup', CalendarBackupService],
  ['Teams backup', TEAMS_BACKUP_USE_CASE_TOKEN],
  ['Outlook deletion', DELETION_USE_CASE_TOKEN],
  ['OneDrive deletion', ONEDRIVE_DELETION_USE_CASE_TOKEN],
  ['SharePoint deletion', SHAREPOINT_DELETION_USE_CASE_TOKEN],
  ['contacts deletion', CONTACTS_DELETION_USE_CASE_TOKEN],
  ['calendar deletion', CALENDAR_DELETION_USE_CASE_TOKEN],
  ['Teams deletion', TEAMS_DELETION_USE_CASE_TOKEN],
  ['Outlook quarantine', OUTLOOK_QUARANTINE_USE_CASE_TOKEN],
  ['OneDrive quarantine', ONEDRIVE_QUARANTINE_USE_CASE_TOKEN],
  ['SharePoint quarantine', SHAREPOINT_QUARANTINE_USE_CASE_TOKEN],
  ['contacts quarantine', CONTACTS_QUARANTINE_USE_CASE_TOKEN],
  ['calendar quarantine', CALENDAR_QUARANTINE_USE_CASE_TOKEN],
  ['Teams quarantine', TEAMS_QUARANTINE_USE_CASE_TOKEN],
  ['Outlook replication and rehydration', REPLICATION_USE_CASE_TOKEN],
  ['OneDrive replication and rehydration', ONEDRIVE_REPLICATION_USE_CASE_TOKEN],
  ['SharePoint replication and rehydration', SHAREPOINT_REPLICATION_USE_CASE_TOKEN],
];

describe('owner lease wiring in the SDK container (issue #623)', () => {
  const container = create_container_from_config(normalize_config(config));

  it('binds one storage-backed lease port', () => {
    const leases = container.get(OWNER_LEASE_TOKEN);

    expect(leases).toBeInstanceOf(StorageOwnerLeases);
    expect(container.get(OWNER_LEASE_TOKEN)).toBe(leases);
  });

  it.each(LEASE_TAKERS)('hands the %s that lease port', (_name, token) => {
    const service = container.get<{ _leases?: unknown }>(token as symbol);

    expect(service._leases).toBe(container.get(OWNER_LEASE_TOKEN));
  });
});
