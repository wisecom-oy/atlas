/** Raw Graph event JSON. Kept untyped past `id` so a backup preserves every property Graph returns. */
export type GraphEventPayload = Readonly<Record<string, unknown>> & { readonly id: string };

export interface GraphCalendar {
  readonly id: string;
  readonly display_name: string;
  readonly is_default: boolean;
  /** False for calendars the mailbox cannot write, such as Birthdays or a read-only shared calendar. */
  readonly can_edit: boolean;
}

export interface CalendarEventDelta {
  readonly upserted: readonly GraphEventPayload[];
  readonly removed_ids: readonly string[];
  readonly delta_link: string;
  /**
   * True when the stored delta link was rejected and the calendar was re-read from scratch.
   * `upserted` is then the complete calendar content and anything absent from it is gone.
   */
  readonly reset: boolean;
}

/** An event attachment as Graph lists it. Only `file` attachments carry bytes Atlas can store. */
export interface GraphEventAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind: 'file' | 'item' | 'reference';
  readonly content_type?: string | undefined;
  readonly is_inline: boolean;
  /** The `cid:` name an inline image is referenced by in the event body. */
  readonly content_id?: string | undefined;
  readonly size: number;
}

/** A file attachment to write onto a restored event. */
export interface EventAttachmentUpload {
  readonly name: string;
  readonly content_type?: string | undefined;
  readonly is_inline: boolean;
  readonly content_id?: string | undefined;
  readonly content: Uint8Array;
}

/** Graph access for a mailbox's calendars. Every method takes `(tenant_id, mailbox_id, ...)`. */
export interface CalendarConnector {
  /** Lists the mailbox's calendars, default calendar first. */
  list_calendars(tenant_id: string, mailbox_id: string): Promise<GraphCalendar[]>;

  /** Reads one calendar's event changes since `delta_link`, or the full calendar when absent. */
  fetch_event_delta(
    tenant_id: string,
    mailbox_id: string,
    calendar_id: string,
    delta_link?: string,
  ): Promise<CalendarEventDelta>;

  /**
   * Reads a series master with its exception and cancelled occurrences, start and end expressed
   * in `time_zone` (a Windows or IANA zone name Exchange accepts).
   */
  fetch_series_master(
    tenant_id: string,
    mailbox_id: string,
    event_id: string,
    time_zone: string,
  ): Promise<GraphEventPayload>;

  /** Lists an event's attachments without their content. */
  list_event_attachments(
    tenant_id: string,
    mailbox_id: string,
    event_id: string,
  ): Promise<GraphEventAttachment[]>;

  /** Returns one file attachment's bytes. */
  fetch_attachment_content(
    tenant_id: string,
    mailbox_id: string,
    event_id: string,
    attachment_id: string,
  ): Promise<Uint8Array>;

  /** Lists a calendar's single instances and series masters, used by restore to detect existing events. */
  list_calendar_events(
    tenant_id: string,
    mailbox_id: string,
    calendar_id: string,
  ): Promise<GraphEventPayload[]>;

  /** Creates a calendar and returns it. */
  create_calendar(tenant_id: string, mailbox_id: string, name: string): Promise<GraphCalendar>;

  /** Creates an event in a calendar and returns its new ID. */
  create_event(
    tenant_id: string,
    mailbox_id: string,
    calendar_id: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<string>;

  /** Lists a series' occurrences and exceptions between two ISO instants, start and end in `time_zone`. */
  list_series_instances(
    tenant_id: string,
    mailbox_id: string,
    series_master_id: string,
    window: { readonly start: string; readonly end: string; readonly time_zone: string },
  ): Promise<GraphEventPayload[]>;

  /** Applies a partial update to an event or occurrence. */
  update_event(
    tenant_id: string,
    mailbox_id: string,
    event_id: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<void>;

  /** Removes one occurrence of a series that this restore created, to replay a cancelled occurrence. */
  delete_occurrence(tenant_id: string, mailbox_id: string, occurrence_id: string): Promise<void>;

  /** Deletes an event or whole series an earlier restore created but left incomplete, to recreate it. */
  delete_event(tenant_id: string, mailbox_id: string, event_id: string): Promise<void>;

  /** Adds a file attachment to an event, using an upload session for large files. */
  upload_event_attachment(
    tenant_id: string,
    mailbox_id: string,
    event_id: string,
    attachment: EventAttachmentUpload,
  ): Promise<void>;
}
