import type { TenantContextFactory } from '@/ports/tenant/context.port';
import {
  delta_of,
  fake_calendar_connector,
  memory_calendar_cursors,
  memory_calendar_manifests,
} from '@/testing/stub-calendar-ports';
import type {
  FakeCalendarConnector,
  MemoryCalendarCursors,
  MemoryCalendarManifests,
} from '@/testing/stub-calendar-ports';
import { tenant_factory_for } from '@/testing/stub-contacts-ports';
import { stub_tenant_context } from '@/testing/stub-tenant-context';

/** In-memory stores a calendar service runs against. `objects` is the bucket behind the storage. */
export interface CalendarStores extends FakeCalendarConnector {
  tenant_factory: TenantContextFactory;
  objects: Record<string, Buffer>;
  manifests: MemoryCalendarManifests;
  cursors: MemoryCalendarCursors;
}

/** Stores plus the service that `calendar_rig` built over them. */
export interface CalendarRig<S> extends CalendarStores {
  service: S;
}

/**
 * Builds a calendar service over in-memory stores. The default and `Work` calendars start with
 * empty deltas so a backup has a link to resume from; tests override the deltas they exercise.
 */
export function calendar_rig<S>(build: (stores: CalendarStores) => S): CalendarRig<S> {
  const fake = fake_calendar_connector();
  const { ctx, objects } = stub_tenant_context();
  fake.script.deltas = {
    'cal-default': delta_of('link-default-1'),
    'cal-work': delta_of('link-work-1'),
  };
  const stores: CalendarStores = {
    ...fake,
    tenant_factory: tenant_factory_for(ctx),
    objects,
    manifests: memory_calendar_manifests(),
    cursors: memory_calendar_cursors(),
  };
  return { ...stores, service: build(stores) };
}
