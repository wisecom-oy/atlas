import { describe, it, expect } from 'vitest';
import {
  find_component,
  find_property,
  parse_icalendar,
} from '@/services/shared/icalendar-document';

/** Parses a document given as its lines, joined the way a mail part carries them. */
function parse_lines(lines: readonly string[]) {
  return parse_icalendar(Buffer.from(lines.join('\r\n'), 'utf-8'));
}

describe('parse_icalendar', () => {
  it('nests components and keeps each property with its own component', () => {
    const root = parse_lines([
      'BEGIN:VCALENDAR',
      'METHOD:REPLY',
      'BEGIN:VTIMEZONE',
      'TZID:W. Europe Standard Time',
      'BEGIN:STANDARD',
      'TZOFFSETTO:+0100',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'SUMMARY:Example subject',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);

    const calendar = find_component(root, 'VCALENDAR')!;
    const zone = find_component(calendar, 'VTIMEZONE')!;
    expect(find_property(calendar, 'METHOD')?.value).toBe('REPLY');
    expect(find_property(zone, 'TZID')?.value).toBe('W. Europe Standard Time');
    expect(find_property(find_component(zone, 'STANDARD')!, 'TZOFFSETTO')?.value).toBe('+0100');
    expect(find_property(find_component(calendar, 'VEVENT')!, 'SUMMARY')?.value).toBe(
      'Example subject',
    );
    expect(find_property(calendar, 'SUMMARY')).toBeUndefined();
  });

  it('joins folded lines, whether the continuation starts with a space or a tab', () => {
    const root = parse_lines([
      'BEGIN:VEVENT',
      'ATTENDEE;CN=Jane Roe;PARTSTAT=',
      ' ACCEPTED:mailto:jane.roe@',
      '\tpartner.example',
      'END:VEVENT',
    ]);

    const attendee = find_property(find_component(root, 'VEVENT')!, 'ATTENDEE')!;
    expect(attendee.parameters.get('PARTSTAT')).toBe('ACCEPTED');
    expect(attendee.value).toBe('mailto:jane.roe@partner.example');
  });

  it('reads parameter names in any case and keeps colons that belong to the value', () => {
    const root = parse_lines(['BEGIN:VEVENT', 'dtstart;tzid=Europe/Berlin:20250310T090000']);

    const start = find_property(find_component(root, 'VEVENT')!, 'DTSTART')!;
    expect(start.parameters.get('TZID')).toBe('Europe/Berlin');
    expect(start.value).toBe('20250310T090000');
  });

  it('does not split a quoted parameter value at the separators inside it', () => {
    const root = parse_lines([
      'BEGIN:VEVENT',
      'ATTENDEE;CN="Roe; Jane: PARTSTAT=DECLINED";PARTSTAT=ACCEPTED:mailto:jane.roe@partner.example',
      'DTSTART;TZID="W. Europe Standard Time":20250310T090000',
    ]);

    const event = find_component(root, 'VEVENT')!;
    const attendee = find_property(event, 'ATTENDEE')!;
    expect(attendee.parameters.get('CN')).toBe('Roe; Jane: PARTSTAT=DECLINED');
    expect(attendee.parameters.get('PARTSTAT')).toBe('ACCEPTED');
    expect(find_property(event, 'DTSTART')!.parameters.get('TZID')).toBe('W. Europe Standard Time');
  });

  // Folding counts octets, so a fold may fall between the two bytes of one character. Decoding
  // before unfolding would turn both halves into replacement characters.
  it('joins a fold that splits a multi-byte character', () => {
    const location = Buffer.from('LOCATION:Sali Ä', 'utf-8');
    const folded = Buffer.concat([
      Buffer.from('BEGIN:VEVENT\r\n', 'utf-8'),
      location.subarray(0, location.length - 1),
      Buffer.from('\r\n ', 'utf-8'),
      location.subarray(location.length - 1),
      Buffer.from('änekoski\r\nEND:VEVENT\r\n', 'utf-8'),
    ]);

    const event = find_component(parse_icalendar(folded), 'VEVENT')!;
    expect(find_property(event, 'LOCATION')?.value).toBe('Sali Äänekoski');
  });

  it('reads documents that end their lines with a bare line feed', () => {
    const root = parse_icalendar(
      Buffer.from('BEGIN:VEVENT\nSUMMARY:Example\n subject\nEND:VEVENT\n', 'utf-8'),
    );

    expect(find_property(find_component(root, 'VEVENT')!, 'SUMMARY')?.value).toBe('Examplesubject');
  });

  it('skips lines that are not content lines and survives an unbalanced END', () => {
    const root = parse_lines([
      'END:VCALENDAR',
      'this line has no separator',
      'BEGIN:VEVENT',
      'SUMMARY:Example subject',
    ]);

    expect(root.properties).toEqual([]);
    expect(find_property(find_component(root, 'VEVENT')!, 'SUMMARY')?.value).toBe(
      'Example subject',
    );
  });

  it('returns an empty root for an empty document', () => {
    expect(parse_icalendar(Buffer.alloc(0))).toEqual({ name: '', properties: [], components: [] });
  });
});
