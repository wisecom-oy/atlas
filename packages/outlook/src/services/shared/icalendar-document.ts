/** One content line of an iCalendar document (RFC 5545 section 3.1), with folding undone. */
export interface IcalendarProperty {
  /** Upper case, such as `DTSTART`. */
  readonly name: string;
  /** Parameter values by upper-case parameter name, with surrounding quotes removed. */
  readonly parameters: ReadonlyMap<string, string>;
  /** The raw value, still carrying any TEXT escapes. */
  readonly value: string;
}

/** A `BEGIN:` to `END:` block of an iCalendar document, such as `VEVENT` or `VTIMEZONE`. */
export interface IcalendarComponent {
  /** Upper case, such as `VEVENT`. The document root has an empty name. */
  readonly name: string;
  readonly properties: IcalendarProperty[];
  readonly components: IcalendarComponent[];
}

/**
 * Parses an iCalendar document into its component tree. The returned root is not a component of
 * the document: it holds the top-level ones, normally a single `VCALENDAR`.
 *
 * The parser is lenient on purpose. Calendar parts come from every mail system there is, so a
 * line that is not a content line is skipped and an unbalanced `END:` is ignored, and the reader
 * decides what it can trust.
 */
export function parse_icalendar(document: Buffer): IcalendarComponent {
  const root: IcalendarComponent = { name: '', properties: [], components: [] };
  const open: IcalendarComponent[] = [root];

  for (const line of unfold_content_lines(document)) {
    const property = parse_content_line(line);
    if (property === undefined) continue;
    const current = open[open.length - 1]!;

    if (property.name === 'BEGIN') {
      const component = {
        name: property.value.trim().toUpperCase(),
        properties: [],
        components: [],
      };
      current.components.push(component);
      open.push(component);
    } else if (property.name === 'END') {
      if (open.length > 1) open.pop();
    } else {
      current.properties.push(property);
    }
  }
  return root;
}

/** Returns the first direct child component with this name. */
export function find_component(
  parent: IcalendarComponent,
  name: string,
): IcalendarComponent | undefined {
  return parent.components.find((component) => component.name === name);
}

/** Returns the first property of a component with this name. */
export function find_property(
  component: IcalendarComponent,
  name: string,
): IcalendarProperty | undefined {
  return component.properties.find((property) => property.name === name);
}

/**
 * Splits a document into content lines, joining the continuation lines RFC 5545 folds them into.
 *
 * Folding counts octets, so a fold may fall inside a multi-byte UTF-8 character. The folds are
 * therefore removed from the bytes, and the text is decoded afterwards. Decoding first would turn
 * the two halves of such a character into replacement characters for good. Latin-1 maps every
 * byte to one code unit and back, which makes it a byte-exact way to edit the buffer as a string.
 */
function unfold_content_lines(document: Buffer): string[] {
  const unfolded_bytes = Buffer.from(
    document.toString('latin1').replace(/\r?\n[ \t]/g, ''),
    'latin1',
  );
  return unfolded_bytes
    .toString('utf-8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

/**
 * Parses `NAME;PARAM=value;PARAM="quoted: value":value`. A quoted parameter value may contain
 * `;` and `:`, so the line is scanned rather than split. Returns nothing for a line with no value
 * separator.
 */
function parse_content_line(line: string): IcalendarProperty | undefined {
  const segments: string[] = [];
  let segment = '';
  let in_quotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === '"') in_quotes = !in_quotes;
    if (in_quotes || (char !== ';' && char !== ':')) {
      segment += char;
      continue;
    }
    segments.push(segment);
    segment = '';
    if (char === ':') return build_property(segments, line.slice(index + 1));
  }
  return undefined;
}

/** Builds a property from its name segment, its `PARAM=value` segments and its value. */
function build_property(segments: readonly string[], value: string): IcalendarProperty | undefined {
  const name = segments[0]?.trim().toUpperCase();
  if (!name) return undefined;

  const parameters = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const separator = segment.indexOf('=');
    if (separator === -1) continue;
    const parameter_name = segment.slice(0, separator).trim().toUpperCase();
    parameters.set(parameter_name, strip_quotes(segment.slice(separator + 1).trim()));
  }
  return { name, parameters, value };
}

/** Removes the double quotes around a quoted parameter value. */
function strip_quotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}
