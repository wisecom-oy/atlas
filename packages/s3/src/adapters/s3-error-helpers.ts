import { S3ServiceException } from '@aws-sdk/client-s3';

/** Builds the CopySource value for same-bucket copy (key segments URI-encoded). */
export function build_s3_copy_source(bucket: string, key: string): string {
  const encoded_key = key.split('/').map(encodeURIComponent).join('/');
  return `${bucket}/${encoded_key}`;
}

export function is_precondition_failed(err: unknown): boolean {
  if (err instanceof S3ServiceException) return err.$metadata.httpStatusCode === 412;
  return (err as { name?: string }).name === 'PreconditionFailed';
}

export function is_backend_mode_rejection(err: unknown, mode?: string): boolean {
  if (!mode) return false;
  if (!(err instanceof S3ServiceException)) return false;
  const error_text = `${err.name} ${err.message}`.toLowerCase();
  return (
    error_text.includes('object lock') ||
    error_text.includes('invalidrequest') ||
    error_text.includes('invalidargument')
  );
}
