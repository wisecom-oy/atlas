interface OperationProgressBase {
  readonly operation: 'backup' | 'restore' | 'save' | 'verify';
  readonly workload: 'outlook' | 'onedrive' | 'sharepoint';
  readonly processed: number;
  readonly total?: number;
  readonly current?: string;
  readonly rate?: number;
}

/** A typed lifecycle event emitted by long-running SDK operations. */
export type OperationProgressEvent =
  | (OperationProgressBase & { readonly phase: 'discovering' })
  | (OperationProgressBase & { readonly phase: 'processing' })
  | (OperationProgressBase & { readonly phase: 'finalizing' })
  | (OperationProgressBase & { readonly phase: 'completed' })
  | (OperationProgressBase & { readonly phase: 'interrupted' });

export type OperationProgressPhase = OperationProgressEvent['phase'];
export type OperationProgressCallback = (event: OperationProgressEvent) => void;

/** Public options shared by long-running SDK operations. */
export interface SdkOperationOptions {
  readonly onProgress?: OperationProgressCallback;
  readonly signal?: AbortSignal;
}

/** Internal hooks used by services without exposing AbortSignal or SDK naming. */
export interface OperationControlOptions {
  readonly on_progress?: OperationProgressCallback;
  readonly should_interrupt?: () => boolean;
}
