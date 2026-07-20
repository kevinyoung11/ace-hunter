import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

export type HttpFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpTransport {
  fetcher: HttpFetcher;
  close(): Promise<void>;
}

export function createHttpTransport(env: Record<string, string | undefined>): HttpTransport {
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (!httpProxy && !httpsProxy) return { fetcher: fetch, close: async () => undefined };
  const dispatcher = new EnvHttpProxyAgent({
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  });
  const fetcher: HttpFetcher = async (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Response;
  // All callers await their requests before cleanup; destroy closes idle
  // proxy tunnels immediately instead of waiting for keep-alive expiry.
  return { fetcher, close: async () => { await dispatcher.destroy(); } };
}
