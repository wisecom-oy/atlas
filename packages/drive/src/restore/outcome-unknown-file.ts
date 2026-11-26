import { WriteOutcomeUnknownError, type OutcomeUnknownFile } from '@wisecom/atlas-types';

/**
 * The record of a file whose upload may have committed although it failed: a single-request upload
 * sent once, or an upload session's final chunk, that ended without a clear answer (issue #893).
 * Undefined for a refusal or any other failure that created nothing.
 */
export function unknown_file_upload(
  err: unknown,
  target_path: string,
  file_name: string,
  error_line: string,
): OutcomeUnknownFile | undefined {
  if (!(err instanceof WriteOutcomeUnknownError)) return undefined;
  return { path: join_target_path(target_path, file_name), error: error_line };
}

/** The target folder path and the file name, with one `/` between them; `.` is the drive root. */
function join_target_path(target_path: string, file_name: string): string {
  if (target_path === '' || target_path === '.' || target_path === '/') return `/${file_name}`;
  return `${target_path.replace(/\/+$/, '')}/${file_name}`;
}
