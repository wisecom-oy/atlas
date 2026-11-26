import { ConfigError } from '@wisecom/atlas-types';
import type { ConditionalWriteViolation } from '@wisecom/atlas-types';

const CONDITIONAL_WRITES_DOCS =
  'https://docs.atlas.wisecom.fi/self-hosting/storage#conditional-writes';

/**
 * The storage backend does not enforce the conditional writes Atlas depends on, so Atlas refused
 * to write to the bucket (issue #915). On such a backend two runs on one owner both take its lease,
 * a create-only manifest can be overwritten, and identity-registry updates are lost or always fail.
 *
 * A `ConfigError` (`ATLAS_CONFIG_INVALID`, exit 6): the backend, not the request, has to change,
 * so a retry returns the same answer. There is no override.
 */
export class ConditionalWritesNotEnforcedError extends ConfigError {
  readonly bucket: string;
  /** The rules the backend broke when Atlas probed it. */
  readonly violations: readonly ConditionalWriteViolation[];

  constructor(bucket: string, violations: readonly ConditionalWriteViolation[], detail: string) {
    super(
      `Refusing to write to bucket ${bucket}: the storage backend does not enforce conditional ` +
        `writes (${detail}). Owner leases, the data key, snapshot manifests and the identity ` +
        'registry depend on them, so concurrent runs could overwrite each other. No lease, key ' +
        `or backup data was written. Use a backend that enforces them; see ${CONDITIONAL_WRITES_DOCS}`,
    );
    this.bucket = bucket;
    this.violations = violations;
  }
}
