import { parseTrending } from "./parse-trending.js";
import type { TrendingCollection, TrendingPeriod, TrendingSource } from "./trending-source.js";
import { TrendingSourceError } from "./trending-source.js";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubTrendingSourceOptions {
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export class GitHubTrendingSource implements TrendingSource {
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  public constructor(options: GitHubTrendingSourceOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 2_000_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) {
      throw new TrendingSourceError("trending_validation_error");
    }
  }

  public async collect(period: TrendingPeriod, language: string): Promise<TrendingCollection> {
    const sourceUrl = canonicalTrendingUrl(period, language);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(new URL(sourceUrl), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "text/html", "Accept-Language": "en-US,en;q=0.9", "User-Agent": "ace-hunter/0.1" },
      });
    } catch {
      clearTimeout(timer);
      throw new TrendingSourceError(controller.signal.aborted ? "timeout" : "network_error");
    }
    try {
      if (response.redirected || response.url && response.url !== sourceUrl) {
        await cancelBody(response);
        throw new TrendingSourceError("trending_redirect");
      }
      if (!response.ok) {
        await cancelBody(response);
        if (response.status === 429 || response.status === 403 && (
          response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
        )) throw new TrendingSourceError("rate_limit");
        if (response.status === 403) throw new TrendingSourceError("source_unavailable");
        if (response.status >= 500) throw new TrendingSourceError("source_unavailable");
        throw new TrendingSourceError("trending_response_invalid");
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/html")) {
        await cancelBody(response);
        throw new TrendingSourceError("trending_response_invalid");
      }
      const html = await readBoundedText(response, this.maxBodyBytes, controller.signal);
      return { entries: parseTrending(html, period), sourceUrl };
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof TrendingSourceError && error.code === "timeout")) {
        throw new TrendingSourceError("timeout");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function canonicalTrendingUrl(period: TrendingPeriod, language: string): string {
  if (!new Set<TrendingPeriod>(["daily", "weekly", "monthly"]).has(period)) {
    throw new TrendingSourceError("trending_validation_error");
  }
  if (language !== "all") {
    throw new TrendingSourceError("trending_validation_error");
  }
  const url = new URL("https://github.com/trending");
  if (url.origin !== "https://github.com" || !url.pathname.startsWith("/trending")) {
    throw new TrendingSourceError("trending_validation_error");
  }
  url.searchParams.set("since", period);
  return url.toString();
}

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      await cancelBody(response);
      throw new TrendingSourceError("trending_response_invalid");
    }
    if (declared > maxBytes) {
      await cancelBody(response);
      throw new TrendingSourceError("trending_response_too_large");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TrendingSourceError("trending_response_invalid");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  while (true) {
    const { done, value } = await abortableRead(reader, signal);
    if (done) break;
    if (++chunkCount > 4_096) {
      await reader.cancel();
      throw new TrendingSourceError("trending_response_too_fragmented");
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TrendingSourceError("trending_response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TrendingSourceError("trending_response_invalid");
  }
}

async function abortableRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    await reader.cancel();
    throw new TrendingSourceError("timeout");
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new TrendingSourceError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } catch (error) {
    if (signal.aborted) await reader.cancel();
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* safe best effort */ }
}
