import type { MeetingResponse } from '@/services/shared/meeting-response-reader';
import type { MeetingSchedule } from '@/services/shared/meeting-schedule-reader';

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

/**
 * Builds the MAPI properties that make a created message a meeting response.
 *
 * The message class makes it restore as a response and not as ordinary mail (issue #817). The
 * start, end, all-day flag and location say which meeting it answers (issue #819): Graph reads
 * them back as `startDateTime`, `endDateTime`, `isAllDay` and `location`. The global object ID is
 * left out on purpose, so the restored response cannot be matched to a live calendar event and
 * change its tracking.
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
  return properties;
}
