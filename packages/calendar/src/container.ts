import { scope_connector_throttling } from '@wisecom/atlas-m365-graph';
import type { Container } from 'inversify';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import {
  CALENDAR_BACKUP_USE_CASE_TOKEN,
  CALENDAR_CATALOG_USE_CASE_TOKEN,
  CALENDAR_CONNECTOR_TOKEN,
  CALENDAR_DELETION_USE_CASE_TOKEN,
  CALENDAR_DELTA_CURSOR_REPOSITORY_TOKEN,
  CALENDAR_MANIFEST_REPOSITORY_TOKEN,
  CALENDAR_RESTORE_USE_CASE_TOKEN,
  CALENDAR_VERIFICATION_USE_CASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  THROTTLE_COORDINATOR_TOKEN,
} from '@wisecom/atlas-types';

import { GraphCalendarConnector } from '@/adapters/graph-calendar-connector.adapter';
import { S3CalendarDeltaCursorRepository } from '@/adapters/s3-calendar-delta-cursor-repository.adapter';
import { S3CalendarManifestRepository } from '@/adapters/s3-calendar-manifest-repository.adapter';
import { CalendarBackupService } from '@/services/backup/backup.service';
import { CalendarCatalogService } from '@/services/catalog/catalog.service';
import { CalendarDeletionService } from '@/services/deletion/deletion.service';
import { CalendarRestoreService } from '@/services/restore/restore.service';
import { CalendarVerificationService } from '@/services/verification/verification.service';

/** Registers calendar DI bindings. Requires TENANT_CONTEXT_FACTORY_TOKEN to be bound first. */
export function bind_calendar(container: Container): void {
  if (!container.isBound(TENANT_CONTEXT_FACTORY_TOKEN)) {
    throw new Error(
      'TENANT_CONTEXT_FACTORY_TOKEN must be bound before calling bind_calendar. ' +
        'Call bind_s3_storage() first.',
    );
  }
  container.bind(GraphCalendarConnector).toSelf().inSingletonScope();
  container
    .bind(CALENDAR_CONNECTOR_TOKEN)
    .toDynamicValue((ctx) =>
      scope_connector_throttling(
        ctx.get(GraphCalendarConnector),
        ctx.get<ThrottleCoordinator>(THROTTLE_COORDINATOR_TOKEN),
        'outlook',
        { owner_argument: 1 },
      ),
    )
    .inSingletonScope();
  container
    .bind(CALENDAR_MANIFEST_REPOSITORY_TOKEN)
    .to(S3CalendarManifestRepository)
    .inSingletonScope();
  container
    .bind(CALENDAR_DELTA_CURSOR_REPOSITORY_TOKEN)
    .to(S3CalendarDeltaCursorRepository)
    .inSingletonScope();

  container.bind(CalendarBackupService).toSelf().inSingletonScope();
  container
    .bind(CALENDAR_BACKUP_USE_CASE_TOKEN)
    .toDynamicValue((ctx) =>
      scope_connector_throttling(
        ctx.get(CalendarBackupService),
        ctx.get<ThrottleCoordinator>(THROTTLE_COORDINATOR_TOKEN),
        'outlook',
        { owner_argument: 1 },
      ),
    )
    .inSingletonScope();
  container.bind(CALENDAR_RESTORE_USE_CASE_TOKEN).to(CalendarRestoreService).inSingletonScope();
  container.bind(CALENDAR_CATALOG_USE_CASE_TOKEN).to(CalendarCatalogService).inSingletonScope();
  container
    .bind(CALENDAR_VERIFICATION_USE_CASE_TOKEN)
    .to(CalendarVerificationService)
    .inSingletonScope();
  container.bind(CALENDAR_DELETION_USE_CASE_TOKEN).to(CalendarDeletionService).inSingletonScope();
}
