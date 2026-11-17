import { scope_connector_throttling } from '@wisecom/atlas-m365-graph';
import type { Container } from 'inversify';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import {
  CONTACTS_QUARANTINE_USE_CASE_TOKEN,
  CONTACTS_BACKUP_USE_CASE_TOKEN,
  CONTACTS_CATALOG_USE_CASE_TOKEN,
  CONTACTS_CONNECTOR_TOKEN,
  CONTACTS_DELETION_USE_CASE_TOKEN,
  CONTACTS_DELTA_CURSOR_REPOSITORY_TOKEN,
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
  CONTACTS_RESTORE_USE_CASE_TOKEN,
  CONTACTS_VERIFICATION_USE_CASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  THROTTLE_COORDINATOR_TOKEN,
} from '@wisecom/atlas-types';

import { GraphContactsConnector } from '@/adapters/graph-contacts-connector.adapter';
import { S3ContactsDeltaCursorRepository } from '@/adapters/s3-contacts-delta-cursor-repository.adapter';
import { S3ContactsManifestRepository } from '@/adapters/s3-contacts-manifest-repository.adapter';
import { ContactsBackupService } from '@/services/backup/backup.service';
import { ContactsCatalogService } from '@/services/catalog/catalog.service';
import { ContactsDeletionService } from '@/services/deletion/deletion.service';
import { ContactsRestoreService } from '@/services/restore/restore.service';
import { ContactsVerificationService } from '@/services/verification/verification.service';
import { ContactsQuarantineService } from '@/services/quarantine/quarantine.service';

/** Registers contacts DI bindings. Requires TENANT_CONTEXT_FACTORY_TOKEN to be bound first. */
export function bind_contacts(container: Container): void {
  if (!container.isBound(TENANT_CONTEXT_FACTORY_TOKEN)) {
    throw new Error(
      'TENANT_CONTEXT_FACTORY_TOKEN must be bound before calling bind_contacts. ' +
        'Call bind_s3_storage() first.',
    );
  }
  container.bind(GraphContactsConnector).toSelf().inSingletonScope();
  container
    .bind(CONTACTS_CONNECTOR_TOKEN)
    .toDynamicValue((ctx) =>
      scope_connector_throttling(
        ctx.get(GraphContactsConnector),
        ctx.get<ThrottleCoordinator>(THROTTLE_COORDINATOR_TOKEN),
        'outlook',
        { owner_argument: 1 },
      ),
    )
    .inSingletonScope();
  container
    .bind(CONTACTS_MANIFEST_REPOSITORY_TOKEN)
    .to(S3ContactsManifestRepository)
    .inSingletonScope();
  container
    .bind(CONTACTS_DELTA_CURSOR_REPOSITORY_TOKEN)
    .to(S3ContactsDeltaCursorRepository)
    .inSingletonScope();

  container.bind(ContactsBackupService).toSelf().inSingletonScope();
  container
    .bind(CONTACTS_BACKUP_USE_CASE_TOKEN)
    .toDynamicValue((ctx) =>
      scope_connector_throttling(
        ctx.get(ContactsBackupService),
        ctx.get<ThrottleCoordinator>(THROTTLE_COORDINATOR_TOKEN),
        'outlook',
        { owner_argument: 1 },
      ),
    )
    .inSingletonScope();
  container.bind(CONTACTS_RESTORE_USE_CASE_TOKEN).to(ContactsRestoreService).inSingletonScope();
  container.bind(CONTACTS_CATALOG_USE_CASE_TOKEN).to(ContactsCatalogService).inSingletonScope();
  container
    .bind(CONTACTS_VERIFICATION_USE_CASE_TOKEN)
    .to(ContactsVerificationService)
    .inSingletonScope();
  container.bind(CONTACTS_DELETION_USE_CASE_TOKEN).to(ContactsDeletionService).inSingletonScope();
  container
    .bind(CONTACTS_QUARANTINE_USE_CASE_TOKEN)
    .to(ContactsQuarantineService)
    .inSingletonScope();
}
