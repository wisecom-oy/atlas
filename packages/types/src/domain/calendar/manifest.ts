/** A calendar as captured in a snapshot. Restore lines calendars up by display name; the default calendar maps to the target's default. */
export interface CalendarRecord {
  readonly calendar_id: string;
  readonly display_name: string;
  readonly is_default: boolean;
}

/** One file attachment of an event, stored as its own content-addressed encrypted object. */
export interface CalendarAttachmentRecord {
  readonly attachment_id: string;
  readonly name: string;
  readonly content_type?: string | undefined;
  readonly is_inline: boolean;
  /** The `cid:` name the event body uses for an inline image; restore must send it back. */
  readonly content_id?: string | undefined;
  readonly storage_key: string;
  readonly checksum: string;
  readonly size_bytes: number;
}

/**
 * One event in a snapshot: a single instance or a recurring series master. A series master's
 * stored JSON carries its `exceptionOccurrences` and `cancelledOccurrences`, with start and end
 * in the series' own time zone so the recurrence expands the same way after restore.
 */
export interface CalendarEventEntry {
  readonly event_id: string;
  readonly calendar_id: string;
  /** Graph `type`: `singleInstance` or `seriesMaster`. */
  readonly event_type: string;
  readonly subject?: string | undefined;
  /** Start as Graph reported it, an ISO date-time in UTC for single instances. */
  readonly start_at?: string | undefined;
  readonly last_modified_at?: string | undefined;
  readonly storage_key: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly attachments?: readonly CalendarAttachmentRecord[] | undefined;
}

/**
 * A full, self-contained view of a mailbox's calendars at backup time. Like contacts there is no
 * chain to fold: each snapshot lists every calendar and event, and unchanged events point at the
 * same content-addressed objects as the previous snapshot.
 */
export interface CalendarSnapshotManifest {
  readonly id: string;
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly snapshot_id: string;
  readonly created_at: string;
  readonly total_events: number;
  readonly total_size_bytes: number;
  readonly calendars: readonly CalendarRecord[];
  readonly entries: readonly CalendarEventEntry[];
}

/** Per-calendar Graph event delta links, persisted between runs. */
export interface CalendarDeltaCursor {
  readonly mailbox_id: string;
  readonly delta_link_by_calendar: Readonly<Record<string, string>>;
  readonly updated_at: string;
  /**
   * The head snapshot when the cursor was saved. The links are resumed only while it is still the
   * newest readable manifest (issue #704). Absent on cursors written before 7.0.
   */
  readonly snapshot_id?: string;
}
