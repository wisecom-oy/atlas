/**
 * Linear slash trimming for paths from outside the function.
 *
 * `path.replace(/\/+$/, '')` is quadratic on a run of slashes that does not end the string
 * (CodeQL js/polynomial-redos): the engine retries the match from every start position. A
 * scan from each end is linear on any input, so path trimming uses these instead of regexes.
 */

/** Removes leading and trailing slashes; never scans the interior. */
export function trim_slashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === '/') start++;
  while (end > start && path[end - 1] === '/') end--;
  return path.slice(start, end);
}

/** Removes trailing slashes only, preserving any leading ones. */
export function trim_trailing_slashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return end === path.length ? path : path.slice(0, end);
}
