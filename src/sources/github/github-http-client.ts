import { z } from "zod";
import { GitHubSourceError, type GitHubRepository, type GitHubSearchPage, type GitHubSource, type SearchSlice } from "./github-source.js";
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

const fullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubHttpClient implements GitHubSource {
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly budget: RequestBudget;
  private preflightComplete = false;

  public constructor(private readonly options: GitHubHttpClientOptions) {
    if (!options.token || options.token.length > 1_024 || /[\r\n]/.test(options.token)) throw new Error("invalid_github_token");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 2_000_000;
    this.budget = new RequestBudget(options.maxRequests ?? 300, options.maxWaitMs ?? 60_000);
  }

  public async getRateLimit(): Promise<{ remaining: number; resetAt: Date }> {
    const { data } = await this.request("/rate_limit", githubRateLimitSchema);
    this.preflightComplete = true;
    return { remaining: data.resources.search.remaining, resetAt: new Date(data.resources.search.reset * 1_000) };
  }

  public async searchRepositories(slice: SearchSlice, page: number): Promise<GitHubSearchPage> {
    if (!this.preflightComplete) await this.getRateLimit();
    if (!Number.isInteger(page) || page < 1 || page > 10) throw new Error("invalid_github_page");
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
    const repositories = data.items
      .filter((item) => item.private === false && item.visibility === "public" && item.disabled === false)
      .map(mapGitHubRepository);
    const nextPage = parseNextPage(headers, page);
    return { totalCount: data.total_count, repositories, rawItemCount: data.items.length, hasNextPage: nextPage !== null, nextPage };
  }

  public async getRepository(fullName: string): Promise<GitHubRepository> {
    const encoded = encodeFullName(fullName);
    const { data } = await this.request(`/repos/${encoded}`, githubRepositorySchema);
    const repository = mapGitHubRepository(data);
    return { ...repository, hasReadme: await this.hasReadme(fullName) };
  }

  public async hasReadme(fullName: string): Promise<boolean> {
    const encoded = encodeFullName(fullName);
    try {
      await this.request(`/repos/${encoded}/readme`, z.object({}).passthrough());
      return true;
    } catch (error) {
      if (error instanceof GitHubStatusError && error.status === 404) return false;
      throw error;
    }
  }

  private async request<T>(path: string, schema: z.ZodType<T>): Promise<{ data: T; headers: Headers }> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("invalid_github_path");
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") throw new Error("invalid_github_origin");
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        throw new Error(controller.signal.aborted ? "github_request_timeout" : "github_network_error");
      }
      if (shouldRetryRateLimit(response)) {
        clearTimeout(timer);
        if (attempt === 1) throw new Error("github_rate_limited");
        const wait = rateLimitWaitMs(response.headers, this.now());
        this.budget.allowWait(wait);
        await this.sleep(wait);
        continue;
      }
      if (!response.ok) { clearTimeout(timer); throw new GitHubStatusError(response.status); }
      let body: unknown;
      try {
        body = await readBoundedJson(response, this.maxBodyBytes);
      } catch (error) {
        if (controller.signal.aborted) throw new Error("github_request_timeout");
        throw error;
      } finally { clearTimeout(timer); }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new Error("github_response_invalid");
      return { data: parsed.data, headers: response.headers };
    }
    throw new Error("github_request_failed");
  }
}

class GitHubStatusError extends Error {
  public constructor(public readonly status: number) {
    super(`github_http_status_${status}`);
    this.name = "GitHubStatusError";
  }
}

function encodeFullName(fullName: string): string {
  if (!fullNamePattern.test(fullName) || fullName.length > 512) throw new Error("invalid_full_name");
  return fullName.split("/").map(encodeURIComponent).join("/");
}

function formatSecond(date: Date): string {
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) throw new Error("invalid_search_slice");
  return date.toISOString().replace(".000Z", "Z");
}

function parseNextPage(headers: Headers, page: number): number | null {
  const link = headers.get("link");
  if (!link) return null;
  const next = link.split(",").map((part) => part.trim()).find((part) => /rel="next"/.test(part));
  if (!next) return null;
  const match = /^<([^>]+)>/.exec(next);
  if (!match) throw new Error("github_response_invalid");
  const url = new URL(match[1]);
  if (url.origin !== "https://api.github.com") throw new Error("github_response_invalid");
  const nextPage = Number(url.searchParams.get("page"));
  if (!Number.isInteger(nextPage) || nextPage !== page + 1 || nextPage > 10) throw new Error("github_response_invalid");
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
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1_000 - now.getTime());
  if (headers.get("x-rateLimit-resource")?.toLowerCase() === "search") return 60_000;
  if (!headers.has("retry-after") && !headers.has("x-ratelimit-reset")) return 60_000;
  throw new Error("github_rate_limit_missing_reset");
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("github_response_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("github_response_too_large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("github_response_invalid");
  }
}
