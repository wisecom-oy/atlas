import { describe_graph_error } from '@wisecom/atlas-m365-graph';
import { graph_status_of } from '@/services/shared/graph-error-status';

/** Graph refused to return a root or its replies with a status the backup acts on. */
export class RootRefusal extends Error {
  constructor(
    readonly status: number,
    cause: unknown,
  ) {
    super(`Graph ${status}: ${describe_graph_error(cause)}`, { cause });
    this.name = 'RootRefusal';
  }
}

/**
 * Runs one Graph call for a root and rethrows a 400 or 404 as a {@link RootRefusal}, so the root
 * applier can classify it. Other errors pass through unchanged.
 */
export async function as_root_refusal<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const status = graph_status_of(err);
    if (status === 400 || status === 404) throw new RootRefusal(status, err);
    throw err;
  }
}
