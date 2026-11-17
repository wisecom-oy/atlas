/**
 * Whether a delta cursor still describes the newest readable snapshot, so its links may be resumed.
 *
 * A cursor's links say where the last run stopped reading Graph. They are only meaningful on top of
 * the snapshot that run wrote, or left as head when it changed nothing. Once that snapshot is gone,
 * whether deleted with `delete -s`, removed with the whole owner, or moved aside by quarantine,
 * resuming the links on top of an older manifest drops every change the missing snapshot recorded
 * (issues #703, #704). The run then reads in full instead.
 *
 * A cursor written before the binding existed names no snapshot. It keeps the older rule: trusted
 * whenever a head manifest exists.
 */
export function cursor_describes_head(
  cursor_snapshot_id: string | undefined,
  head_snapshot_id: string | undefined,
): boolean {
  if (head_snapshot_id === undefined) return false;
  return cursor_snapshot_id === undefined || cursor_snapshot_id === head_snapshot_id;
}
