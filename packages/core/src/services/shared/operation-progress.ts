import type { OperationControlOptions, OperationProgressEvent } from '@wisecom/atlas-types';

type Operation = OperationProgressEvent['operation'];
type Workload = OperationProgressEvent['workload'];

/** Emits discovery progress and reports whether cancellation was requested. */
export function begin_operation_progress(
  control: OperationControlOptions,
  operation: Operation,
  workload: Workload,
): boolean {
  emit_operation_progress(control, { operation, workload, phase: 'discovering', processed: 0 });
  return control.should_interrupt?.() === true;
}

/** Emits finalizing and exactly one terminal event, returning interruption state. */
export function finish_operation_progress(
  control: OperationControlOptions,
  operation: Operation,
  workload: Workload,
  processed: number,
  total?: number,
  force_interrupted = false,
): boolean {
  emit_operation_progress(control, {
    operation,
    workload,
    phase: 'finalizing',
    processed,
    ...(total === undefined ? {} : { total }),
  });
  const interrupted = force_interrupted || control.should_interrupt?.() === true;
  emit_operation_progress(control, {
    operation,
    workload,
    phase: interrupted ? 'interrupted' : 'completed',
    processed,
    ...(total === undefined ? {} : { total }),
  });
  return interrupted;
}

/** Calls a progress observer without allowing it to alter operation state. */
export function emit_operation_progress(
  control: OperationControlOptions,
  event: OperationProgressEvent,
): void {
  try {
    control.on_progress?.(event);
  } catch {
    // Progress observers are informational, never part of operation control.
  }
}
