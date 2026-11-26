import { ConfigError } from '@wisecom/atlas-types';
import type { WriterExclusionMode } from '@wisecom/atlas-types';

/** The variable an operator sets to run the CLI without storage leases (issue #974). */
export const SINGLE_WRITER_ENV_VAR = 'ATLAS_SINGLE_WRITER';

const ENABLED = ['1', 'true'];
const DISABLED = ['', '0', 'false'];

/**
 * The writer-exclusion mode `ATLAS_SINGLE_WRITER` selects: `single_writer` for `1` or `true`, the
 * default storage lease when it is unset, empty, `0` or `false`. Any other value is refused rather
 * than read as either, because a typo must not change how two writers are kept apart.
 *
 * @throws ConfigError when the value is not one of those.
 */
export function read_env_writer_exclusion(): WriterExclusionMode {
  const raw = (process.env[SINGLE_WRITER_ENV_VAR] ?? '').trim().toLowerCase();
  if (ENABLED.includes(raw)) return 'single_writer';
  if (DISABLED.includes(raw)) return 'storage_lease';
  throw new ConfigError(
    `${SINGLE_WRITER_ENV_VAR} must be 1, true, 0 or false. Set it to 1 only when one Atlas ` +
      'process at a time writes each tenant.',
  );
}
