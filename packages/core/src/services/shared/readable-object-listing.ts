import { UnreadableContentError, UnreadableObjectsError } from '@wisecom/atlas-types';

/** What a listing read: every readable object in key order, and the keys it could not read. */
export interface ReadableObjects<T> {
  readonly items: T[];
  readonly unreadable_keys: string[];
  /** Why each key in `unreadable_keys` could not be read, in the same order. */
  readonly unreadable_errors: UnreadableContentError[];
}

type ReadOutcome<T> = { readonly item?: T; readonly error?: UnreadableContentError };

/**
 * Reads every key with at most `concurrency` reads in flight, keeping key order.
 *
 * A read that raises `UnreadableContentError` names its key in `unreadable_keys` and the listing
 * goes on, so one damaged object never hides the others (issue #631). A read that returns
 * `undefined` found nothing and is dropped. Any other error, such as a storage outage, still fails
 * the whole listing: it says nothing about the object, and skipping it would read as absence.
 */
export async function read_each_readable<T>(
  keys: readonly string[],
  read: (key: string) => Promise<T | undefined>,
  concurrency = 1,
): Promise<ReadableObjects<T>> {
  const outcomes = new Array<ReadOutcome<T>>(keys.length);
  let next_index = 0;

  const run_worker = async (): Promise<void> => {
    while (next_index < keys.length) {
      const index = next_index;
      next_index++;
      outcomes[index] = await read_or_capture_unreadable(keys[index]!, read);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, run_worker));

  const listing: ReadableObjects<T> = { items: [], unreadable_keys: [], unreadable_errors: [] };
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.error) {
      listing.unreadable_keys.push(keys[index]!);
      listing.unreadable_errors.push(outcome.error);
    } else if (outcome.item !== undefined) {
      listing.items.push(outcome.item);
    }
  }
  return listing;
}

/** Runs one read, capturing an unreadable object's error and passing every other error on. */
async function read_or_capture_unreadable<T>(
  key: string,
  read: (key: string) => Promise<T | undefined>,
): Promise<ReadOutcome<T>> {
  try {
    const item = await read(key);
    return item === undefined ? {} : { item };
  } catch (err) {
    if (err instanceof UnreadableContentError) return { error: err };
    throw err;
  }
}

/**
 * Returns `items` when nothing was skipped, and raises otherwise. For reads whose answer is wrong
 * without every object, such as a restore chain or a replication copy.
 *
 * One damaged object raises the error its read raised, so the reason stays as specific as it was.
 * Several raise one `UnreadableObjectsError` naming every key, with the first reason as its cause.
 */
export function require_every_object_readable<T>(listing: ReadableObjects<T>, what: string): T[] {
  const [first, ...rest] = listing.unreadable_errors;
  if (first === undefined) return listing.items;
  if (rest.length === 0 && first instanceof UnreadableObjectsError) throw first;
  throw new UnreadableObjectsError(
    `${listing.unreadable_keys.length} ${what} could not be read`,
    listing.unreadable_keys,
    { cause: first },
  );
}
