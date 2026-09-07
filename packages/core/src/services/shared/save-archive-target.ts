import type { Writable } from 'node:stream';
import { ConfigError } from '@wisecom/atlas-types';
import type { ArchiveTarget } from '@/services/shared/file-save-zip-writer';

export interface SaveTargetOptions {
  readonly output?: Writable;
  readonly output_path?: string;
}

export interface ResolvedSaveTarget {
  readonly target: ArchiveTarget;
  /** The path the archive lands on, or an empty string when the caller supplied a stream. */
  readonly output_path: string;
}

/**
 * Resolves where a save writes: the caller's stream, an explicit path, or the generated default.
 *
 * Shared by every workload so one rule governs all of them. Passing both a stream and a path is
 * refused rather than resolved by precedence: whichever one lost would be somewhere an operator
 * expected the export to be, and a silently ignored `output_path` is how an export goes missing.
 */
export function resolve_save_target(
  options: SaveTargetOptions,
  default_path: () => string,
): ResolvedSaveTarget {
  if (options.output && options.output_path !== undefined) {
    throw new ConfigError(
      'Specify either output (a stream) or outputPath (a file), not both. Atlas writes one archive.',
    );
  }
  if (options.output) return { target: options.output, output_path: '' };
  const output_path = options.output_path ?? default_path();
  return { target: output_path, output_path };
}
