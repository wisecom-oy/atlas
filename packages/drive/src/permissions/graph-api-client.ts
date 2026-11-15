/**
 * The slice of the Graph SDK's fluent client the shared sharing calls use. The SDK `Client` the
 * providers inject satisfies it structurally, so this package needs no dependency on the SDK, and a
 * test passes `stub_graph_client` directly.
 */
export interface GraphApiRequest {
  get(): Promise<unknown>;
  post(body: unknown): Promise<unknown>;
}

/** A Graph client: one request builder per path. */
export interface GraphApiClient {
  api(path: string): GraphApiRequest;
}
