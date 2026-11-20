import { describe, it, expect } from 'vitest';
import { build_global_object_ids } from '@/services/restore/global-object-id';

/** Decodes a base64 property value to upper-case hex, which is how the IDs are written down. */
function to_hex(base64: string | undefined): string | undefined {
  return base64 === undefined
    ? undefined
    : Buffer.from(base64, 'base64').toString('hex').toUpperCase();
}

const PREFIX = '040000008200E00074C5B7101A82E008';
const NO_OCCURRENCE = '00000000';
const CREATION_TIME = '30B1C4D5E6F7DA01';
const RESERVED = '0000000000000000';
const DATA = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const SIXTEEN_BYTES = '10000000';

/** A `UID` as Outlook writes it: the hex of the global object ID itself. */
const OUTLOOK_UID = PREFIX + NO_OCCURRENCE + CREATION_TIME + RESERVED + SIXTEEN_BYTES + DATA;

// Rebuilt this way, the ID equalled the one Exchange stored for every meeting message compared in
// a live mailbox: 39 with an Outlook UID and 3 with a Google Calendar UID (issue #819).
describe('build_global_object_ids', () => {
  it('uses an Outlook UID as the ID itself', () => {
    const ids = build_global_object_ids({ uid: OUTLOOK_UID });

    expect(to_hex(ids?.global_object_id)).toBe(OUTLOOK_UID);
    expect(to_hex(ids?.clean_global_object_id)).toBe(OUTLOOK_UID);
  });

  it('reads an Outlook UID written in lower case', () => {
    const ids = build_global_object_ids({ uid: OUTLOOK_UID.toLowerCase() });

    expect(to_hex(ids?.clean_global_object_id)).toBe(OUTLOOK_UID);
  });

  it('wraps a UID no Outlook wrote behind the vCal-Uid marker', () => {
    const ids = build_global_object_ids({ uid: 'meeting-4c1f@partner.example' });

    const wrapped =
      PREFIX +
      NO_OCCURRENCE +
      '0000000000000000' + // creation time
      RESERVED +
      '29000000' + // 41 bytes of data follow
      '7643616C2D55696401000000' + // "vCal-Uid", then the marker version
      '6D656574696E672D3463316640706172746E65722E6578616D706C65' + // the UID
      '00';
    expect(to_hex(ids?.global_object_id)).toBe(wrapped);
    expect(to_hex(ids?.clean_global_object_id)).toBe(wrapped);
  });

  // A message about one occurrence of a series names it by the date it was first set for. The
  // clean ID stays the one of the whole series.
  it('writes the occurrence date into the ID and leaves the clean ID without it', () => {
    const ids = build_global_object_ids({
      uid: OUTLOOK_UID,
      occurrence_date: { year: 2025, month: 3, day: 10 },
    });

    const with_occurrence = PREFIX + '07E9030A' + CREATION_TIME + RESERVED + SIXTEEN_BYTES + DATA;
    expect(to_hex(ids?.global_object_id)).toBe(with_occurrence);
    expect(to_hex(ids?.clean_global_object_id)).toBe(OUTLOOK_UID);
  });

  it('zeroes an occurrence date the UID itself carries', () => {
    const uid_with_date = PREFIX + '07E9030A' + CREATION_TIME + RESERVED + SIXTEEN_BYTES + DATA;

    const ids = build_global_object_ids({ uid: uid_with_date });

    expect(to_hex(ids?.global_object_id)).toBe(OUTLOOK_UID);
    expect(to_hex(ids?.clean_global_object_id)).toBe(OUTLOOK_UID);
  });

  it('writes the occurrence date into a wrapped UID as well', () => {
    const ids = build_global_object_ids({
      uid: 'meeting-4c1f@partner.example',
      occurrence_date: { year: 2025, month: 12, day: 31 },
    });

    expect(to_hex(ids?.global_object_id)?.slice(32, 40)).toBe('07E90C1F');
    expect(to_hex(ids?.clean_global_object_id)?.slice(32, 40)).toBe(NO_OCCURRENCE);
  });

  it('wraps a hex UID that does not start like a global object ID', () => {
    const ids = build_global_object_ids({ uid: 'A1B2C3D4E5F60718' });

    expect(to_hex(ids?.clean_global_object_id)).toContain('7643616C2D55696401000000');
  });

  // What Exchange makes of these was not observed, and a wrong ID would tie the response to no
  // meeting or to another one.
  it.each([
    ['is cut short of its header', PREFIX + NO_OCCURRENCE + CREATION_TIME],
    ['holds less data than its size field says', OUTLOOK_UID.slice(0, -4)],
    ['holds more data than its size field says', `${OUTLOOK_UID}FFFF`],
  ])('returns nothing for an Outlook UID that %s', (_label, uid) => {
    expect(build_global_object_ids({ uid })).toBeUndefined();
  });
});
