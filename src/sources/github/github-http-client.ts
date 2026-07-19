import { z } from "zod";
import { GitHubSourceError, type GitHubRepository, type GitHubSearchPage, type GitHubSourceFactory, type GitHubSourceOperation, type SearchSlice } from "./github-source.js";
import { githubRateLimitSchema, githubRepositorySchema, githubSearchResponseSchema, mapGitHubRepository } from "./schemas.js";
import { RequestBudget } from "./request-budget.js";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubHttpClientOptions {
  token: string;
  fetcher?: Fetcher;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRequests?: number;
  maxWaitMs?: number;
}

export class GitHubHttpClientFactory implements GitHubSourceFactory {
  public constructor(private readonly options: GitHubHttpClientOptions) {}
  public openOperation(): GitHubSourceOperation { return new GitHubHttpClient(this.options); }
}

const fullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubHttpClient implements GitHubSourceOperation {
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly budget: RequestBudget;
  private preflightComplete = false;
  private pendingResetAt: Date | null = null;

  public constructor(private readonly options: GitHubHttpClientOptions) {
    if (!options.token || options.token.length > 1_024 || /[\r\n]/.test(options.token)) throw new GitHubSourceError("authentication_error");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 2_000_000;
    for (const [value, minimum] of [[this.timeoutMs, 1], [this.maxBodyBytes, 1], [options.maxRequests ?? 4_500, 1], [options.maxWaitMs ?? 60_000, 0]] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) throw new GitHubSourceError("invalid_client_options");
    }
    this.budget = new RequestBudget(options.maxRequests ?? 4_500, options.maxWaitMs ?? 60_000);
  }

  public close(): void { /* no persistent transport resources */ }

  public async getRateLimit(): Promise<{ remaining: number; resetAt: Date }> {
    this.pendingResetAt = null;
    let { data } = await this.request("/rate_limit", githubRateLimitSchema);
    if (data.resources.search.remaining === 0) {
      if (data.resources.search.reset <= 0) throw new GitHubSourceError("rate_limit_reset_invalid");
      const resetAt = new Date(data.resources.search.reset * 1_000);
      await this.waitUntil(resetAt);
      ({ data } = await this.request("/rate_limit", githubRateLimitSchema));
      if (data.resources.search.remaining === 0) throw new GitHubSourceError("rate_limit");
    }
    this.preflightComplete = true;
    return { remaining: data.resources.search.remaining, resetAt: new Date(data.resources.search.reset * 1_000) };
  }

  public async searchRepositories(slice: SearchSlice, page: number): Promise<GitHubSearchPage> {
    if (!this.preflightComplete) await this.getRateLimit();
    if (!Number.isInteger(page) || page < 1 || page > 10) throw new GitHubSourceError("invalid_page");
    const query = [
      `created:${formatSecond(slice.from)}..${formatSecond(slice.to)}`,
      `stars:${slice.minStars}..${slice.maxStars ?? "*"}`,
      "is:public", "archived:false", "mirror:false",
    ].join(" ");
    const search = new URLSearchParams({ q: query, sort: "stars", order: "desc", per_page: "100", page: String(page) });
    let envelope = await this.request(`/search/repositories?${search.toString()}`, githubSearchResponseSchema);
    if (envelope.data.incomplete_results) envelope = await this.request(`/search/repositories?${search.toString()}`, githubSearchResponseSchema);
    const { data, headers } = envelope;
    if (data.incomplete_results) throw new GitHubSourceError("search_incomplete");
    let repositories: GitHubRepository[];
    try {
      repositories = data.items
        .filter((item) => item.private === false && item.visibility === "public" && item.disabled === false)
        .map(mapGitHubRepository);
    } catch { throw new GitHubSourceError("repository_invalid"); }
    const nextPage = parseNextPage(headers, page);
    return { totalCount: data.total_count, repositories, rawItemCount: data.items.length, hasNextPage: nextPage !== null, nextPage };
  }

  public async getRepository(fullName: string): Promise<GitHubRepository> {
    const encoded = encodeFullName(fullName);
    const { data } = await this.request(`/repos/${encoded}`, githubRepositorySchema);
    let repository: GitHubRepository;
    try { repository = mapGitHubRepository(data); } catch (error) {
      const code = error instanceof Error && error.message === "repository_inaccessible" ? "repository_inaccessible" :
        error instanceof Error && error.message === "private_repository" ? "not_found" : "repository_invalid";
      throw new GitHubSourceError(code);
    }
    return { ...repository, hasReadme: await this.hasReadme(fullName) };
  }

  public async hasReadme(fullName: string): Promise<boolean> {
    const encoded = encodeFullName(fullName);
    try {
      await this.request(`/repos/${encoded}/readme`, z.object({}).passthrough());
      return true;
    } catch (error) {
      if (error instanceof GitHubSourceError && error.code === "not_found") return false;
      throw error;
    }
  }

  private async request<T>(path: string, schema: z.ZodType<T>): Promise<{ data: T; headers: Headers }> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new GitHubSourceError("invalid_request");
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") throw new GitHubSourceError("invalid_request");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.pendingResetAt) { const reset = this.pendingResetAt; this.pendingResetAt = null; await this.waitUntil(reset); }
      this.budget.consumeRequest();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.options.token}`,
            "User-Agent": "ace-hunter/0.1",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
      } catch {
        clearTimeout(timer);
        throw new GitHubSourceError(controller.signal.aborted ? "timeout" : "network_error");
      }
      if (response.status === 403 && !shouldRetryRateLimit(response)) {
        let secondary: boolean;
        try { secondary = await isHeaderlessSecondaryLimit(response, this.maxBodyBytes, controller.signal); }
        finally { clearTimeout(timer); }
        if (!secondary) throw new GitHubSourceError("authentication_error");
        if (attempt === 1) throw new GitHubSourceError("rate_limit");
        await this.waitMilliseconds(60_000);
        continue;
      }
      if (shouldRetryRateLimit(response)) {
        clearTimeout(timer);
        await cancelBody(response);
        if (attempt === 1) throw new GitHubSourceError("rate_limit");
        const wait = rateLimitWaitMs(response.headers, this.now());
        await this.waitMilliseconds(wait);
        continue;
      }
      if (!response.ok) { clearTimeout(timer); await cancelBody(response); throw statusError(response.status); }
      let body: unknown;
      try {
        body = await readBoundedJson(response, this.maxBodyBytes, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw new GitHubSourceError("timeout");
        throw error;
      } finally { clearTimeout(timer); }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new GitHubSourceError("response_invalid");
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0" && url.pathname.startsWith("/search/")) this.pendingResetAt = parseResetHeader(response.headers);
      return { data: parsed.data, headers: response.headers };
    }
    throw new GitHubSourceError("source_unavailable");
  }

  private async waitUntil(resetAt: Date): Promise<void> {
    const raw = resetAt.getTime() + 1_000 - this.now().getTime();
    if (!Number.isFinite(raw)) throw new GitHubSourceError("rate_limit_reset_invalid");
    await this.waitMilliseconds(Math.max(0, raw));
  }
  private async waitMilliseconds(milliseconds: number): Promise<void> {
    this.budget.allowWait(milliseconds);
    await this.sleep(milliseconds);
  }
}

function encodeFullName(fullName: string): string {
  if (!fullNamePattern.test(fullName) || fullName.length > 512) throw new GitHubSourceError("invalid_full_name");
  return fullName.split("/").map(encodeURIComponent).join("/");
}

function formatSecond(date: Date): string {
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) throw new GitHubSourceError("invalid_search_slice");
  return date.toISOString().replace(".000Z", "Z");
}

function parseNextPage(headers: Headers, page: number): number | null {
  const link = headers.get("link");
  if (!link) return null;
  const next = link.split(",").map((part) => part.trim()).find((part) => /rel="next"/.test(part));
  if (!next) return null;
  const match = /^<([^>]+)>/.exec(next);
  if (!match) throw new GitHubSourceError("response_invalid");
  let url: URL;
  try { url = new URL(match[1]); } catch { throw new GitHubSourceError("response_invalid"); }
  if (url.origin !== "https://api.github.com") throw new GitHubSourceError("response_invalid");
  const nextPage = Number(url.searchParams.get("page"));
  if (!Number.isInteger(nextPage) || nextPage !== page + 1 || nextPage > 10) throw new GitHubSourceError("response_invalid");
  return nextPage;
}

function shouldRetryRateLimit(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0";
}

function rateLimitWaitMs(headers: Headers, now: Date): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const absolute = Date.parse(retryAfter);
    if (Number.isFinite(absolute)) return Math.max(0, absolute - now.getTime());
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1_000 + 1_000 - now.getTime());
  if (headers.get("x-rateLimit-resource")?.toLowerCase() === "search") return 60_000;
  if (!headers.has("retry-after") && !headers.has("x-ratelimit-reset")) return 60_000;
  throw new GitHubSourceError("rate_limit_reset_invalid");
}

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) { await cancelBody(response); throw new GitHubSourceError("response_invalid"); }
    if (declared > maxBytes) { await cancelBody(response); throw new GitHubSourceError("response_too_large"); }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GitHubSourceError("response_invalid");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  while (true) {
    const { done, value } = await abortableRead(reader, signal);
    if (done) break;
    if (++chunkCount > 4_096) { await reader.cancel(); throw new GitHubSourceError("response_too_fragmented"); }
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new GitHubSourceError("response_too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GitHubSourceError("response_invalid");
  }
}

async function abortableRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) { await reader.cancel(); throw new GitHubSourceError("timeout"); }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new GitHubSourceError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([reader.read(), aborted]); }
  catch (error) { if (signal.aborted) await reader.cancel(); throw error; }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

function statusError(status: number): GitHubSourceError {
  if (status === 401 || status === 403) return new GitHubSourceError("authentication_error");
  if (status === 404) return new GitHubSourceError("not_found");
  if (status >= 500) return new GitHubSourceError("source_unavailable");
  return new GitHubSourceError("response_invalid");
}
function parseResetHeader(headers: Headers): Date {
  const seconds = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new GitHubSourceError("rate_limit_reset_invalid");
  return new Date(seconds * 1_000);
}
async function cancelBody(response: Response): Promise<void> { try { await response.body?.cancel(); } catch { /* ignore */ } }

async function isHeaderlessSecondaryLimit(response: Response, maxBodyBytes: number, signal: AbortSignal): Promise<boolean> {
  let body: unknown;
  try { body = await readBoundedJson(response, Math.min(maxBodyBytes, 32_768), signal); }
  catch (error) {
    if (error instanceof GitHubSourceError && error.code === "response_invalid") return false;
    throw error;
  }
  const parsed = z.object({ message: z.string().max(1_000) }).passthrough().safeParse(body);
  if (!parsed.success) return false;
  const message = parsed.data.message.toLowerCase();
  return message.includes("secondary rate limit") || message.includes("abuse detection");
}
