import type { MeetingResponse } from '@/services/shared/meeting-response-reader';
import type { MeetingSchedule } from '@/services/shared/meeting-schedule-reader';
import { build_global_object_ids } from '@/services/restore/global-object-id';

const PR_MESSAGE_CLASS = 'String 0x001A';

const MEETING_RESPONSE_CLASSES: Record<MeetingResponse, string> = {
  accepted: 'IPM.Schedule.Meeting.Resp.Pos',
  declined: 'IPM.Schedule.Meeting.Resp.Neg',
  tentative: 'IPM.Schedule.Meeting.Resp.Tent',
};

/** PSETID_Appointment, the property set the meeting time and location live in. */
const APPOINTMENT_PROPERTY_SET = '{00062002-0000-0000-C000-000000000046}';
const PID_LID_APPOINTMENT_START_WHOLE = `SystemTime ${APPOINTMENT_PROPERTY_SET} Id 0x820D`;
const PID_LID_APPOINTMENT_END_WHOLE = `SystemTime ${APPOINTMENT_PROPERTY_SET} Id 0x820E`;
const PID_LID_LOCATION = `String ${APPOINTMENT_PROPERTY_SET} Id 0x8208`;
/** The all-day flag. Graph reports `isAllDay` as `null` on a response that lacks it. */
const PID_LID_APPOINTMENT_SUB_TYPE = `Boolean ${APPOINTMENT_PROPERTY_SET} Id 0x8215`;

/** PSETID_Meeting, the property set the identifiers of a meeting live in. */
const MEETING_PROPERTY_SET = '{6ED8DA90-450B-101B-98DA-00AA003F1305}';
const PID_LID_GLOBAL_OBJECT_ID = `Binary ${MEETING_PROPERTY_SET} Id 0x3`;
const PID_LID_CLEAN_GLOBAL_OBJECT_ID = `Binary ${MEETING_PROPERTY_SET} Id 0x23`;

/**
 * Builds the MAPI properties that make a created message a meeting response.
 *
 * The message class makes it restore as a response and not as ordinary mail (issue #817). The
 * start, end, all-day flag and location say when and where the meeting is (issue #819): Graph
 * reads them back as `startDateTime`, `endDateTime`, `isAllDay` and `location`.
 *
 * The global object ID says which meeting it is, and it is the real one, rebuilt from the `UID`
 * the backup holds. Exchange needs it to write the time and location into the MIME of the
 * restored response, so without it a later backup captures a response that has lost them again.
 * It also links the response to its meeting where that still exists. In a live test, responses
 * created this way that disagreed with the attendee's current answer left the meeting's tracking
 * as it was, whether they were dated before or after that answer.
 *
 * Extended properties are the only way in. Graph documents no operation that creates an
 * `eventMessage`, and its update takes five message fields and none of the meeting ones, while
 * setting extended properties on a new message is a documented operation. What is not documented
 * is which MAPI properties Exchange accepts there: the set below was established by live probes.
 *
 * Only responses get any of this. Graph answers `500 ErrorItemSavePropertyError` to the request
 * and cancellation classes on create and on update alike, and appointment properties on an
 * ordinary message would mean nothing.
 */
export function build_meeting_response_properties(
  response: MeetingResponse | undefined,
  schedule: MeetingSchedule | undefined,
): Array<{ id: string; value: string }> {
  if (response === undefined) return [];

  const properties = [{ id: PR_MESSAGE_CLASS, value: MEETING_RESPONSE_CLASSES[response] }];
  if (schedule?.time) {
    properties.push({ id: PID_LID_APPOINTMENT_START_WHOLE, value: schedule.time.start });
    properties.push({ id: PID_LID_APPOINTMENT_END_WHOLE, value: schedule.time.end });
    properties.push({ id: PID_LID_APPOINTMENT_SUB_TYPE, value: String(schedule.time.is_all_day) });
  }
  if (schedule?.location) properties.push({ id: PID_LID_LOCATION, value: schedule.location });

  const ids = schedule?.identity && build_global_object_ids(schedule.identity);
  if (ids) {
    properties.push({ id: PID_LID_GLOBAL_OBJECT_ID, value: ids.global_object_id });
    properties.push({ id: PID_LID_CLEAN_GLOBAL_OBJECT_ID, value: ids.clean_global_object_id });
  }
  return properties;
}
