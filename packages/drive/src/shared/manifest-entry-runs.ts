/** Consecutive manifest entries, each already serialised, and their combined UTF-8 size. */
export interface SerialisedEntryRun {
  readonly entry_texts: string[];
  readonly byte_length: number;
}

/**
 * Serialises the entries one at a time and yields them in consecutive runs whose combined size
 * stays within `part_bytes`. An entry larger than `part_bytes` on its own forms a run by itself.
 *
 * Generating lazily is the point: the whole manifest is never one string, and a caller that writes
 * each run before asking for the next holds only the runs it has not written yet.
 */
export function* split_entries_by_size(
  entries: readonly unknown[],
  part_bytes: number,
): Generator<SerialisedEntryRun> {
  let entry_texts: string[] = [];
  let byte_length = 0;
  for (const entry of entries) {
    const text = serialise_entry(entry);
    const size = Buffer.byteLength(text, 'utf-8') + 1;
    if (entry_texts.length > 0 && byte_length + size > part_bytes) {
      yield { entry_texts, byte_length };
      entry_texts = [];
      byte_length = 0;
    }
    entry_texts.push(text);
    byte_length += size;
  }
  if (entry_texts.length > 0) yield { entry_texts, byte_length };
}

/** One entry as it would appear inside a JSON array: a value with no JSON form becomes `null`. */
function serialise_entry(entry: unknown): string {
  return JSON.stringify(entry) ?? 'null';
}
