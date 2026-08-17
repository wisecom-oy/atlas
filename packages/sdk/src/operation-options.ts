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
