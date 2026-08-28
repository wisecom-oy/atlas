import type {
  OperationControlOptions,
  OperationProgressCallback,
  SdkOperationOptions,
} from '@wisecom/atlas-types';

type AdaptedOperationOptions<T extends SdkOperationOptions> = Omit<T, 'onProgress' | 'signal'> &
  OperationControlOptions;

/** Maps public SDK progress/cancellation options to internal service hooks. */
export function adapt_operation_options<T extends SdkOperationOptions>(
  options: T | undefined,
): AdaptedOperationOptions<T> | undefined {
  if (!options) return undefined;
  const { onProgress: on_progress, signal, ...rest } = options;
  return {
    ...rest,
    ...(on_progress ? { on_progress: isolate_progress_callback(on_progress) } : {}),
    ...(signal ? { should_interrupt: () => signal.aborted } : {}),
  };
}

/** Options whose port contract requires a snapshot to act on. */
type SnapshotScopedOptions = SdkOperationOptions & { readonly snapshot_id?: string };

/**
 * Adapts options that the port marks mandatory, failing at the call boundary when they are absent.
 *
 * A TypeScript caller cannot reach this, but the package ships to JavaScript too, and there the
 * argument was forwarded through a non-null assertion: omitting it crashed several frames deep with
 * `Cannot read properties of undefined (reading 'should_interrupt')`, which names an internal
 * control flag rather than the mistake (issue #204).
 *
 * A missing `snapshot_id` fails the same way and for the same reason. Without it the service has
 * nothing to restore or export from, so letting it through only moves the error further from the
 * caller.
 */
export function adapt_required_operation_options<T extends SnapshotScopedOptions>(
  options: T | undefined,
  method: string,
): AdaptedOperationOptions<T> {
  const adapted = adapt_operation_options(options);
  const snapshot_id = (adapted as { snapshot_id?: unknown } | undefined)?.snapshot_id;

  if (adapted === undefined || typeof snapshot_id !== 'string' || snapshot_id.trim() === '') {
    throw new TypeError(`${method} requires an options object with a snapshot_id`);
  }

  return adapted;
}

/** Prevents observer failures from changing operation state. */
function isolate_progress_callback(callback: OperationProgressCallback): OperationProgressCallback {
  return (event) => {
    try {
      callback(event);
    } catch {
      // Progress observers cannot participate in operation control.
    }
  };
}
