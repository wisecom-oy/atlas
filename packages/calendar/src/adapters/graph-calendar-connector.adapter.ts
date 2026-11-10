import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import type {
  CalendarConnector,
  CalendarEventDelta,
  EventAttachmentUpload,
  GraphCalendar,
  GraphEventAttachment,
  GraphEventPayload,
} from '@wisecom/atlas-types';
import { inject, injectable } from 'inversify';
import {
  fetch_attachment_content,
  list_event_attachments,
  upload_event_attachment,
} from '@/adapters/graph-calendar-attachments';
import { create_calendar, list_calendars } from '@/adapters/graph-calendar-calendars';
import { fetch_calendar_delta } from '@/adapters/graph-calendar-delta';
import {
  create_event,
  delete_event,
  fetch_series_master,
  list_calendar_events,
  list_series_instances,
  update_event,
} from '@/adapters/graph-calendar-events';

/** Microsoft Graph implementation of the calendar connector. */
@injectable()
export class GraphCalendarConnector implements CalendarConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Lists the mailbox's calendars, default calendar first. */
  async list_calendars(_tenant_id: string, mailbox_id: string): Promise<GraphCalendar[]> {
    return list_calendars(this._client, mailbox_id);
  }

  /** Reads one calendar's event changes since `delta_link`, or the full calendar when absent. */
  async fetch_event_delta(
    _tenant_id: string,
    mailbox_id: string,
    calendar_id: string,
    delta_link?: string,
  ): Promise<CalendarEventDelta> {
    return fetch_calendar_delta(this._client, mailbox_id, calendar_id, delta_link);
  }

  /** Reads a series master with its exceptions and cancellations, in `time_zone`. */
  async fetch_series_master(
    _tenant_id: string,
    mailbox_id: string,
    event_id: string,
    time_zone: string,
  ): Promise<GraphEventPayload> {
    return fetch_series_master(this._client, mailbox_id, event_id, time_zone);
  }

  /** Lists an event's attachments without their content. */
  async list_event_attachments(
    _tenant_id: string,
    mailbox_id: string,
    event_id: string,
  ): Promise<GraphEventAttachment[]> {
    return list_event_attachments(this._client, mailbox_id, event_id);
  }

  /** Returns one file attachment's bytes. */
  async fetch_attachment_content(
    _tenant_id: string,
    mailbox_id: string,
    event_id: string,
    attachment_id: string,
  ): Promise<Uint8Array> {
    return fetch_attachment_content(this._client, mailbox_id, event_id, attachment_id);
  }

  /** Lists a calendar's events with the fields restore matches on. */
  async list_calendar_events(
    _tenant_id: string,
    mailbox_id: string,
    calendar_id: string,
  ): Promise<GraphEventPayload[]> {
    return list_calendar_events(this._client, mailbox_id, calendar_id);
  }

  /** Creates a calendar. */
  async create_calendar(
    _tenant_id: string,
    mailbox_id: string,
    name: string,
  ): Promise<GraphCalendar> {
    return create_calendar(this._client, mailbox_id, name);
  }

  /** Creates an event and returns its id. */
  async create_event(
    _tenant_id: string,
    mailbox_id: string,
    calendar_id: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    return create_event(this._client, mailbox_id, calendar_id, payload);
  }

  /** Lists a series' occurrences and exceptions in a window. */
  async list_series_instances(
    _tenant_id: string,
    mailbox_id: string,
    series_master_id: string,
    window: { readonly start: string; readonly end: string; readonly time_zone: string },
  ): Promise<GraphEventPayload[]> {
    return list_series_instances(this._client, mailbox_id, series_master_id, window);
  }

  /** Applies a partial update to an event or occurrence. */
  async update_event(
    _tenant_id: string,
    mailbox_id: string,
    event_id: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return update_event(this._client, mailbox_id, event_id, patch);
  }

  /** Removes one occurrence of a series this restore created. */
  async delete_occurrence(
    _tenant_id: string,
    mailbox_id: string,
    occurrence_id: string,
  ): Promise<void> {
    return delete_event(this._client, mailbox_id, occurrence_id);
  }

  /** Deletes an event or whole series an earlier restore created but never completed. */
  async delete_event(_tenant_id: string, mailbox_id: string, event_id: string): Promise<void> {
    return delete_event(this._client, mailbox_id, event_id);
  }

  /** Adds a file attachment to an event. */
  async upload_event_attachment(
    _tenant_id: string,
    mailbox_id: string,
    event_id: string,
    attachment: EventAttachmentUpload,
  ): Promise<void> {
    return upload_event_attachment(this._client, mailbox_id, event_id, attachment);
  }
}
