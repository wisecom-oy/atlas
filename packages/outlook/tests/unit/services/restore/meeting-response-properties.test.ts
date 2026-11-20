import { describe, it, expect } from 'vitest';
import { build_meeting_response_properties } from '@/services/restore/meeting-response-properties';
import type { MeetingSchedule } from '@/services/shared/meeting-schedule-reader';

const MESSAGE_CLASS = 'String 0x001A';
const APPOINTMENT_SET = '{00062002-0000-0000-C000-000000000046}';
const START = `SystemTime ${APPOINTMENT_SET} Id 0x820D`;
const END = `SystemTime ${APPOINTMENT_SET} Id 0x820E`;
const ALL_DAY = `Boolean ${APPOINTMENT_SET} Id 0x8215`;
const LOCATION = `String ${APPOINTMENT_SET} Id 0x8208`;
const MEETING_SET = '{6ED8DA90-450B-101B-98DA-00AA003F1305}';
const GLOBAL_OBJECT_ID = `Binary ${MEETING_SET} Id 0x3`;
const CLEAN_GLOBAL_OBJECT_ID = `Binary ${MEETING_SET} Id 0x23`;

/** The ID a `UID` of `meeting-4c1f@partner.example` wraps to, as base64. */
const WRAPPED_ID =
  'BAAAAIIA4AB0xbcQGoLgCAAAAAAAAAAAAAAAAAAAAAAAAAAAKQAAAHZDYWwtVWlkAQAAAG1lZXRpbmctNGMxZkBwYXJ0bmVyLmV4YW1wbGUA';

const TIMED: MeetingSchedule = {
  time: { start: '2024-07-10T09:00:00.000Z', end: '2024-07-10T09:30:00.000Z', is_all_day: false },
  location: 'Room 1',
};

// These are the properties a live probe showed Graph to accept on create and to read back as
// startDateTime, endDateTime, isAllDay and location (issue #819).
describe('build_meeting_response_properties', () => {
  it('writes the class, the time, the all-day flag and the location of a response', () => {
    expect(build_meeting_response_properties('accepted', TIMED)).toEqual([
      { id: MESSAGE_CLASS, value: 'IPM.Schedule.Meeting.Resp.Pos' },
      { id: START, value: '2024-07-10T09:00:00.000Z' },
      { id: END, value: '2024-07-10T09:30:00.000Z' },
      { id: ALL_DAY, value: 'false' },
      { id: LOCATION, value: 'Room 1' },
    ]);
  });

  it('flags an all-day meeting', () => {
    const all_day: MeetingSchedule = {
      time: {
        start: '2024-07-15T00:00:00.000Z',
        end: '2024-07-16T00:00:00.000Z',
        is_all_day: true,
      },
    };

    expect(build_meeting_response_properties('tentative', all_day)).toEqual([
      { id: MESSAGE_CLASS, value: 'IPM.Schedule.Meeting.Resp.Tent' },
      { id: START, value: '2024-07-15T00:00:00.000Z' },
      { id: END, value: '2024-07-16T00:00:00.000Z' },
      { id: ALL_DAY, value: 'true' },
    ]);
  });

  it('writes a location without a time, and no all-day flag then', () => {
    expect(build_meeting_response_properties('declined', { location: 'Room 1' })).toEqual([
      { id: MESSAGE_CLASS, value: 'IPM.Schedule.Meeting.Resp.Neg' },
      { id: LOCATION, value: 'Room 1' },
    ]);
  });

  // The real ID, rebuilt from the UID the backup holds. Without it Exchange writes no time into
  // the MIME of the restored response, and a later backup captures it without one.
  it('writes the global object ID of the meeting, and the clean one beside it', () => {
    const schedule: MeetingSchedule = { identity: { uid: 'meeting-4c1f@partner.example' } };

    expect(build_meeting_response_properties('accepted', schedule)).toEqual([
      { id: MESSAGE_CLASS, value: 'IPM.Schedule.Meeting.Resp.Pos' },
      { id: GLOBAL_OBJECT_ID, value: WRAPPED_ID },
      { id: CLEAN_GLOBAL_OBJECT_ID, value: WRAPPED_ID },
    ]);
  });

  it('writes no ID for a UID that cannot be turned into one with certainty', () => {
    const cut_short = '040000008200E00074C5B7101A82E00800000000';
    const schedule: MeetingSchedule = { ...TIMED, identity: { uid: cut_short } };

    const ids = build_meeting_response_properties('accepted', schedule).map(({ id }) => id);

    expect(ids).toEqual([MESSAGE_CLASS, START, END, ALL_DAY, LOCATION]);
  });

  it('writes the class alone when the calendar part gave no schedule', () => {
    expect(build_meeting_response_properties('accepted', undefined)).toEqual([
      { id: MESSAGE_CLASS, value: 'IPM.Schedule.Meeting.Resp.Pos' },
    ]);
  });

  // Requests and cancellations restore as ordinary mail, and appointment properties on an
  // ordinary message would mean nothing.
  it('writes nothing for a message that is not a response, schedule or not', () => {
    expect(build_meeting_response_properties(undefined, TIMED)).toEqual([]);
  });
});
