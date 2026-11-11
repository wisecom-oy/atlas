/**
 * Cancels the unread body of a response the caller is not going to use.
 *
 * Node's fetch (undici) keeps the connection busy until a body is read or cancelled, so a 429 or
 * an error status left unread holds a socket until garbage collection gets to it. A failed cancel
 * changes nothing for the caller, which is already giving the response up, so it is swallowed.
 */
export async function discard_response_body(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
