/**
 * Appends every item of `items` to `target` in place, one push per item.
 *
 * `target.push(...items)` passes each element as a separate call argument, and V8 throws
 * `RangeError: Maximum call stack size exceeded` once that count passes its argument limit
 * (about 125k on Node 22 with the default stack). Folder, mailbox and library entry arrays reach
 * that size on large tenants, so accumulating them with a spread push fails the whole run after
 * the work is done. This loop has no such limit.
 */
export function append_all<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}
