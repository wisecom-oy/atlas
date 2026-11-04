/** The HTTP status Graph reported for an error, or undefined when it reported none. */
export function graph_status_of(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object' && 'statusCode' in err) {
    const status = err.statusCode;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}
