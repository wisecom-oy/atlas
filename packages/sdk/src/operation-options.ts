import type { OperationControlOptions, SdkOperationOptions } from '@wisecom/atlas-types';

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
    ...(on_progress ? { on_progress } : {}),
    ...(signal ? { should_interrupt: () => signal.aborted } : {}),
  };
}
