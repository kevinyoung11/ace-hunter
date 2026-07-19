import { z } from "zod";
import { GitHubSourceError, type AuxMetrics, type CoreMetrics, type GitHubMetricSourceFactory, type GitHubMetricSourceOperation, type GitHubRepository, type GitHubSearchPage, type GitHubSourceFactory, type SearchSlice } from "./github-source.js";
import { githubRateLimitSchema, githubRepositorySchema, githubSearchResponseSchema, mapGitHubRepository } from "./schemas.js";
import { RequestBudget } from "./request-budget.js";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubHttpClientOptions {
  token: string;
  signal?: AbortSignal;
  fetcher?: Fetcher;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRequests?: number;
  maxWaitMs?: number;
}

export class GitHubHttpClientFactory implements GitHubSourceFactory, GitHubMetricSourceFactory {
  public constructor(private readonly options: GitHubHttpClientOptions) {}
  public openOperation(): GitHubHttpClient { return new GitHubHttpClient(this.options); }
}

const fullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const metricCountSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
const graphRepositorySchema = z.object({
  nameWithOwner: z.string().min(3).max(512),
  defaultBranchRef: z.object({
    name: z.string().min(1).max(1_024),
    target: z.object({ history: z.object({ totalCount: metricCountSchema }).passthrough() }).passthrough(),
  }).nullable(),
  pullsOpen: z.object({ totalCount: metricCountSchema }).passthrough(),
  pullsClosed: z.object({ totalCount: metricCountSchema }).passthrough(),
  pullsMerged: z.object({ totalCount: metricCountSchema }).passthrough(),
  issuesOpen: z.object({ totalCount: metricCountSchema }).passthrough(),
  issuesClosed: z.object({ totalCount: metricCountSchema }).passthrough(),
  releases: z.object({
    nodes: z.array(z.object({
      id: z.string().min(1).max(1_024), isDraft: z.boolean(), isPrerelease: z.boolean().default(false),
      publishedAt: z.string().max(64).nullable(), tagName: z.string().max(1_024),
    }).passthrough()).max(100),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(1_024).nullable() }).passthrough(),
  }).passthrough(),
}).passthrough();
const graphRateLimitSchema = z.object({ cost: metricCountSchema, remaining: metricCountSchema, resetAt: z.string().max(64) }).passthrough();
const graphErrorSchema = z.object({
  message: z.string().max(2_000),
  extensions: z.object({ type: z.string().max(100).optional(), code: z.string().max(100).optional() }).passthrough().optional(),
}).passthrough();
const graphEnvelopeSchema = z.object({
  data: z.object({ repository: graphRepositorySchema.nullable(), rateLimit: graphRateLimitSchema }).passthrough().nullable(),
  errors: z.array(graphErrorSchema).max(100).optional(),
}).passthrough();
const releaseRepositorySchema = z.object({
  nameWithOwner: z.string().min(3).max(512),
  defaultBranchRef: z.object({ name: z.string().min(1).max(1_024) }).nullable(),
  releases: graphRepositorySchema.shape.releases,
}).passthrough();
const releaseEnvelopeSchema = z.object({
  data: z.object({ repository: releaseRepositorySchema.nullable(), rateLimit: graphRateLimitSchema }).passthrough().nullable(),
  errors: z.array(graphErrorSchema).max(100).optional(),
}).passthrough();
const metricGraphQuery = `query RepositoryMetrics($owner:String!,$name:String!,$since:GitTimestamp!,$until:GitTimestamp!,$releaseCursor:String) {
  repository(owner:$owner,name:$name) {
    nameWithOwner
    defaultBranchRef { name target { ... on Commit { history(first:1,since:$since,until:$until) { totalCount } } } }
    pullsOpen: pullRequests(first:1,states:[OPEN]) { totalCount }
    pullsClosed: pullRequests(first:1,states:[CLOSED]) { totalCount }
    pullsMerged: pullRequests(first:1,states:[MERGED]) { totalCount }
    issuesOpen: issues(first:1,states:[OPEN]) { totalCount }
    issuesClosed: issues(first:1,states:[CLOSED]) { totalCount }
    releases(first:100,after:$releaseCursor,orderBy:{field:CREATED_AT,direction:DESC}) {
      nodes { id isDraft isPrerelease publishedAt tagName }
      pageInfo { hasNextPage endCursor }
    }
  }
  rateLimit { cost remaining resetAt }
}`;
const releasePageGraphQuery = `query RepositoryReleasePage($owner:String!,$name:String!,$releaseCursor:String) {
  repository(owner:$owner,name:$name) {
    nameWithOwner
    defaultBranchRef { name }
    releases(first:100,after:$releaseCursor,orderBy:{field:CREATED_AT,direction:DESC}) {
      nodes { id isDraft isPrerelease publishedAt tagName }
      pageInfo { hasNextPage endCursor }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

export class GitHubHttpClient implements GitHubMetricSourceOperation {
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly budget: RequestBudget;
  private preflightComplete = false;
  private readonly pendingResets = new Map<"search" | "core" | "graphql", Date>();

  public constructor(private readonly options: GitHubHttpClientOptions) {
    if (!options.token || options.token.length > 1_024 || options.token !== options.token.trim() || hasAsciiOrC1Control(options.token)) {
      throw new GitHubSourceError("authentication_error");
    }
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 2_000_000;
    for (const [value, minimum] of [[this.timeoutMs, 1], [this.maxBodyBytes, 1], [options.maxRequests ?? 4_500, 1], [options.maxWaitMs ?? 60_000, 0]] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) throw new GitHubSourceError("invalid_client_options");
    }
    this.budget = new RequestBudget(options.maxRequests ?? 4_500, options.maxWaitMs ?? 60_000);
  }

  public close(): void { /* no persistent transport resources */ }

  public async getMetricRateLimit(): Promise<{ coreRemaining: number; graphqlRemaining: number; resetAt: Date }> {
    this.pendingResets.delete("core");
    this.pendingResets.delete("graphql");
    let { data } = await this.request("/rate_limit", githubRateLimitSchema);
    let limits = requireMetricLimits(data.resources);
    if (limits.core.remaining === 0) {
      const resetAt = new Date(limits.core.reset * 1_000);
      await this.waitUntil(resetAt);
      ({ data } = await this.request("/rate_limit", githubRateLimitSchema));
      limits = requireMetricLimits(data.resources);
      if (limits.core.remaining === 0) throw new GitHubSourceError("rate_limit");
    }
    this.preflightComplete = true;
    return { coreRemaining: limits.core.remaining, graphqlRemaining: limits.graphql.remaining,
      resetAt: new Date(Math.min(limits.core.reset, limits.graphql.reset) * 1_000) };
  }

  public async getCoreMetrics(fullName: string, capturedAt: Date): Promise<CoreMetrics> {
    requireValidCaptureTime(capturedAt);
    const encoded = encodeFullName(fullName);
    const { data } = await this.request(`/repos/${encoded}`, githubRepositorySchema);
    let metadata: GitHubRepository;
    try { metadata = mapGitHubRepository(data); }
    catch (error) {
      const code = error instanceof Error && error.message === "repository_inaccessible" ? "repository_inaccessible" :
        error instanceof Error && error.message === "private_repository" ? "not_found" : "repository_invalid";
      throw new GitHubSourceError(code);
    }
    return { stars: metadata.stars, forks: metadata.forks, metadata, capturedAt: new Date(capturedAt) };
  }

  public async getAuxMetrics(fullName: string, defaultBranch: string, capturedAt: Date): Promise<AuxMetrics> {
    requireValidCaptureTime(capturedAt);
    encodeFullName(fullName);
    if (!defaultBranch || defaultBranch.length > 255 || hasAsciiOrC1Control(defaultBranch)) {
      throw new GitHubSourceError("invalid_default_branch");
    }
    const [owner, name] = fullName.split("/");
    const since = new Date(capturedAt.getTime() - 30 * 86_400_000).toISOString();
    const until = capturedAt.toISOString();
    let releasesCount = 0;
    let latestReleaseAt: Date | null = null;
    let latestReleaseTag: string | null = null;
    const maxReleasePages = 10;
    const first: { data: z.infer<typeof graphEnvelopeSchema>; headers: Headers } = await this.request("/graphql", graphEnvelopeSchema, {
      method: "POST", body: JSON.stringify({ query: metricGraphQuery, variables: { owner, name, since, until, releaseCursor: null } }),
    });
    throwGraphErrors(first.data.errors);
    if (first.data.data === null) throw new GitHubSourceError("response_invalid");
    if (first.data.data.repository === null) throw new GitHubSourceError("not_found");
    captureGraphLimit(this.pendingResets, first.data.data.rateLimit);
    const counts = first.data.data.repository;
    if (counts.nameWithOwner.toLowerCase() !== fullName.toLowerCase()) throw new GitHubSourceError("repository_identity_mismatch");
    if (counts.defaultBranchRef !== null && counts.defaultBranchRef.name !== defaultBranch) throw new GitHubSourceError("default_branch_mismatch");
    let releases = counts.releases;
    const cursors = new Set<string>();
    const releaseIds = new Set<string>();
    for (let page = 0; page < maxReleasePages; page += 1) {
      for (const release of releases.nodes) {
        if (releaseIds.has(release.id)) throw new GitHubSourceError("response_invalid");
        releaseIds.add(release.id);
        if (release.isDraft || release.publishedAt === null) continue;
        releasesCount += 1;
        const publishedAt = new Date(release.publishedAt);
        if (!Number.isFinite(publishedAt.getTime())) throw new GitHubSourceError("response_invalid");
        if (latestReleaseAt === null || publishedAt > latestReleaseAt ||
            publishedAt.getTime() === latestReleaseAt.getTime() && release.tagName.localeCompare(latestReleaseTag ?? "") < 0) {
          latestReleaseAt = publishedAt; latestReleaseTag = release.tagName;
        }
      }
      if (!releases.pageInfo.hasNextPage) break;
      const next: string | null = releases.pageInfo.endCursor;
      if (!next || next.length > 1_024 || cursors.has(next)) throw new GitHubSourceError("response_invalid");
      cursors.add(next);
      if (page === maxReleasePages - 1) throw new GitHubSourceError("pagination_limit_exceeded");
      const envelope: { data: z.infer<typeof releaseEnvelopeSchema>; headers: Headers } = await this.request("/graphql", releaseEnvelopeSchema, {
        method: "POST", body: JSON.stringify({ query: releasePageGraphQuery, variables: { owner, name, releaseCursor: next } }),
      });
      throwGraphErrors(envelope.data.errors);
      if (envelope.data.data === null) throw new GitHubSourceError("response_invalid");
      if (envelope.data.data.repository === null) throw new GitHubSourceError("not_found");
      captureGraphLimit(this.pendingResets, envelope.data.data.rateLimit);
      const repository = envelope.data.data.repository;
      if (repository.nameWithOwner.toLowerCase() !== fullName.toLowerCase()) throw new GitHubSourceError("repository_identity_mismatch");
      if (repository.defaultBranchRef !== null && repository.defaultBranchRef.name !== defaultBranch) throw new GitHubSourceError("default_branch_mismatch");
      releases = repository.releases;
    }
    const prOpen = counts.pullsOpen.totalCount;
    const prClosed = counts.pullsClosed.totalCount;
    const prMerged = counts.pullsMerged.totalCount;
    const prTotal = prOpen + prClosed + prMerged;
    if (!Number.isSafeInteger(prTotal)) throw new GitHubSourceError("response_invalid");
    const issuesOpen = counts.issuesOpen.totalCount;
    const issuesClosed = counts.issuesClosed.totalCount;
    const issuesTotal = issuesOpen + issuesClosed;
    if (!Number.isSafeInteger(issuesTotal)) throw new GitHubSourceError("response_invalid");
    return { commits30d: counts.defaultBranchRef?.target.history.totalCount ?? 0, prTotal, prOpen, prMerged,
      releasesCount, latestReleaseAt, latestReleaseTag, issuesTotal, issuesOpen, issuesClosed,
      capturedAt: new Date(capturedAt) };
  }

  public async getRateLimit(): Promise<{ remaining: number; resetAt: Date }> {
    this.pendingResets.delete("search");
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

  private async request<T>(path: string, schema: z.ZodType<T>, init: { method?: "GET" | "POST"; body?: string } = {}): Promise<{ data: T; headers: Headers }> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new GitHubSourceError("invalid_request");
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") throw new GitHubSourceError("invalid_request");
    const resource = requestResource(url.pathname);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reset = resource ? this.pendingResets.get(resource) : undefined;
      if (resource && reset) { this.pendingResets.delete(resource); await this.waitUntil(reset); }
      this.budget.consumeRequest();
      const controller = new AbortController();
      const signal = this.options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, this.options.signal]);
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: init.method ?? "GET",
          body: init.body,
          redirect: "error",
          signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.options.token}`,
            "User-Agent": "ace-hunter/0.1",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
        });
      } catch {
        clearTimeout(timer);
        throw new GitHubSourceError(signal.aborted ? "timeout" : "network_error");
      }
      if (response.status === 403 && !shouldRetryRateLimit(response)) {
        let secondary: boolean;
        try { secondary = await isHeaderlessSecondaryLimit(response, this.maxBodyBytes, signal); }
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
        body = await readBoundedJson(response, this.maxBodyBytes, signal);
      } catch (error) {
        if (signal.aborted) throw new GitHubSourceError("timeout");
        throw error;
      } finally { clearTimeout(timer); }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new GitHubSourceError("response_invalid");
      if (resource) this.captureExhaustedResource(response.headers, resource);
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
    const signal = this.options.signal;
    if (signal?.aborted) throw new GitHubSourceError("timeout");
    try {
      if (signal === undefined) await this.sleep(milliseconds);
      else await this.sleep(milliseconds, signal);
    } catch {
      if (signal?.aborted) throw new GitHubSourceError("timeout");
      throw new GitHubSourceError("source_unavailable");
    }
    if (signal?.aborted) throw new GitHubSourceError("timeout");
  }
  private captureExhaustedResource(headers: Headers, requestedResource: "search" | "core" | "graphql"): void {
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining === null || Number(remaining) !== 0) return;
    const resource = headers.get("x-ratelimit-resource")?.toLowerCase();
    if (resource !== requestedResource) throw new GitHubSourceError("rate_limit_resource_invalid");
    this.pendingResets.set(requestedResource, parseResetHeader(headers));
  }
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

function hasAsciiOrC1Control(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code >= 0x7f && code <= 0x9f;
  });
}

function requireValidCaptureTime(value: Date): void {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < Date.UTC(1970, 0, 1) || milliseconds >= Date.UTC(2100, 0, 1)) {
    throw new GitHubSourceError("invalid_capture_time");
  }
}

function requestResource(pathname: string): "search" | "core" | "graphql" | null {
  if (pathname === "/rate_limit") return null;
  if (pathname === "/graphql") return "graphql";
  if (pathname.startsWith("/search/")) return "search";
  return "core";
}

function requireMetricLimits(resources: unknown): {
  core: { remaining: number; reset: number }; graphql: { remaining: number; reset: number };
} {
  const parsed = z.object({
    core: z.object({ remaining: metricCountSchema, reset: metricCountSchema }),
    graphql: z.object({ remaining: metricCountSchema, reset: metricCountSchema }),
  }).safeParse(resources);
  if (!parsed.success || parsed.data.core.reset <= 0 || parsed.data.graphql.reset <= 0) {
    throw new GitHubSourceError("response_invalid");
  }
  return parsed.data;
}

function throwGraphErrors(errors: z.infer<typeof graphErrorSchema>[] | undefined): void {
  if (!errors?.length) return;
  let missing = false;
  const limited = errors.some((error) => {
    const type = error.extensions?.type?.toUpperCase();
    const code = error.extensions?.code?.toUpperCase();
    if (type === "NOT_FOUND" || code === "NOT_FOUND") missing = true;
    return type === "RATE_LIMITED" || code === "RATE_LIMITED";
  });
  throw new GitHubSourceError(limited ? "rate_limit" : missing ? "not_found" : "response_invalid");
}

function captureGraphLimit(
  pending: Map<"search" | "core" | "graphql", Date>,
  rateLimit: z.infer<typeof graphRateLimitSchema>,
): void {
  const resetAt = new Date(rateLimit.resetAt);
  if (!Number.isFinite(resetAt.getTime())) throw new GitHubSourceError("response_invalid");
  if (rateLimit.remaining === 0) pending.set("graphql", resetAt);
}
