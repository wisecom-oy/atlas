import type { MeetingIdentity } from '@/services/shared/meeting-identity-reader';

/** The identifiers Exchange keys a meeting on, as base64 for a Graph `Binary` extended property. */
export interface GlobalObjectIds {
  /** PidLidGlobalObjectId: names one occurrence when the message is about one. */
  readonly global_object_id: string;
  /** PidLidCleanGlobalObjectId: the same bytes with no occurrence date, naming the whole meeting. */
  readonly clean_global_object_id: string;
}

/** The byte array id every global object ID starts with ([MS-OXOCAL] 2.2.1.27). */
const GLOBAL_OBJECT_ID_PREFIX = Buffer.from('040000008200E00074C5B7101A82E008', 'hex');
const OCCURRENCE_DATE_OFFSET = 16;
/** Prefix, occurrence date, creation time, reserved bytes and the size field. */
const HEADER_LENGTH = 40;
const SIZE_FIELD_OFFSET = 36;
const FOREIGN_UID_MARKER = Buffer.concat([
  Buffer.from('vCal-Uid', 'ascii'),
  Buffer.from([1, 0, 0, 0]),
]);

/**
 * Rebuilds the global object ID of a meeting from the `UID` of its calendar part, the way Exchange
 * derives one on delivery ([MS-OXCICAL] 2.1.3.1.1.20.26).
 *
 * A `UID` that Outlook wrote is the hex of the ID itself. Any other `UID`, such as one from
 * Google Calendar, is wrapped behind a `vCal-Uid` marker. Rebuilt this way, the ID matched the
 * stored one for every meeting message compared in a live mailbox, of both kinds.
 *
 * Returns nothing for a hex `UID` that starts like a global object ID and is not a whole one. What
 * Exchange makes of that was not observed, and a wrong ID would tie the message to no meeting or
 * to another one.
 */
export function build_global_object_ids(identity: MeetingIdentity): GlobalObjectIds | undefined {
  const clean = build_clean_global_object_id(identity.uid);
  if (clean === undefined) return undefined;

  const with_occurrence = Buffer.from(clean);
  if (identity.occurrence_date) {
    const { year, month, day } = identity.occurrence_date;
    with_occurrence.writeUInt16BE(year, OCCURRENCE_DATE_OFFSET);
    with_occurrence.writeUInt8(month, OCCURRENCE_DATE_OFFSET + 2);
    with_occurrence.writeUInt8(day, OCCURRENCE_DATE_OFFSET + 3);
  }
  return {
    global_object_id: with_occurrence.toString('base64'),
    clean_global_object_id: clean.toString('base64'),
  };
}

/** Builds the ID with its occurrence date zeroed, from either kind of `UID`. */
function build_clean_global_object_id(uid: string): Buffer | undefined {
  const outlook_id = decode_hex(uid);
  if (outlook_id?.subarray(0, GLOBAL_OBJECT_ID_PREFIX.length).equals(GLOBAL_OBJECT_ID_PREFIX)) {
    if (!is_whole_global_object_id(outlook_id)) return undefined;
    outlook_id.fill(0, OCCURRENCE_DATE_OFFSET, OCCURRENCE_DATE_OFFSET + 4);
    return outlook_id;
  }
  return wrap_foreign_uid(uid);
}

/** Decodes a string made only of hex digit pairs, or returns nothing for any other string. */
function decode_hex(value: string): Buffer | undefined {
  return /^(?:[0-9a-fA-F]{2})+$/.test(value) ? Buffer.from(value, 'hex') : undefined;
}

/** Whether the bytes hold the full header and exactly as much data as the size field says. */
function is_whole_global_object_id(id: Buffer): boolean {
  return (
    id.length >= HEADER_LENGTH && id.readUInt32LE(SIZE_FIELD_OFFSET) === id.length - HEADER_LENGTH
  );
}

/** Wraps a `UID` no Outlook wrote: header with zeroed dates, then the marker and the `UID`. */
function wrap_foreign_uid(uid: string): Buffer {
  const data = Buffer.concat([FOREIGN_UID_MARKER, Buffer.from(uid, 'utf-8'), Buffer.from([0])]);
  const header = Buffer.alloc(HEADER_LENGTH);
  GLOBAL_OBJECT_ID_PREFIX.copy(header);
  header.writeUInt32LE(data.length, SIZE_FIELD_OFFSET);
  return Buffer.concat([header, data]);
}
