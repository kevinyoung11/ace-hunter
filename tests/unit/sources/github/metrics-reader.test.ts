import { describe, expect, it, vi } from "vitest";
import { needsAuxRefresh, normalizeMetrics } from "../../../../src/sources/github/metrics-reader.js";
import { GitHubHttpClient } from "../../../../src/sources/github/github-http-client.js";

describe("GitHub metric timing", () => {
  it("refreshes auxiliary facts at the exact six-hour boundary", () => {
    const now = new Date("2026-07-19T12:00:00Z");
    expect(needsAuxRefresh(null, now)).toBe(true);
    expect(needsAuxRefresh(new Date("2026-07-19T06:00:00Z"), now)).toBe(true);
    expect(needsAuxRefresh(new Date("2026-07-19T06:00:00.001Z"), now)).toBe(false);
  });

  it("keeps confirmed zero distinct from an unavailable field", () => {
    expect(normalizeMetrics({ issuesOpen: 0 }).issuesOpen).toBe(0);
    expect(normalizeMetrics({}).issuesOpen).toBeNull();
  });

  it("rejects invalid times and metric counts", () => {
    expect(() => needsAuxRefresh(null, new Date(Number.NaN))).toThrow("invalid_metric_time");
    expect(() => normalizeMetrics({ issuesOpen: -1 })).toThrow("invalid_metric_count");
  });
});

describe("GitHub GraphQL auxiliary metrics", () => {
  it("uses an exact 30-day default-branch window, separates PR/issues, and fully filters release pages", async () => {
    let graphPage = 0;
    const client = new GitHubHttpClient({ token: "t", fetcher: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      graphPage += 1;
      if (graphPage === 1) {
        expect(request.variables).toMatchObject({ owner: "owner", name: "repo", since: "2026-06-19T12:00:00.000Z", until: "2026-07-19T12:00:00.000Z" });
        expect(request.query).toContain("history(first:1");
        return json({ data: { repository: graphRepo([
          { id: "draft", isDraft: true, publishedAt: "2026-07-19T00:00:00Z", tagName: "draft" },
          { id: "r2", isDraft: false, publishedAt: "2026-07-18T00:00:00Z", tagName: "v2" },
          { id: "pre", isDraft: false, isPrerelease: true, publishedAt: "2026-07-17T00:00:00Z", tagName: "v2-rc" },
          ...Array.from({ length: 97 }, (_, index) => ({ id: `old-${index}`, isDraft: false,
            publishedAt: "2026-07-01T00:00:00Z", tagName: `old-${index}` })),
        ], true, "cursor-1"), rateLimit: graphLimit() } });
      }
      expect(request.query).toContain("RepositoryReleasePage");
      return json({ data: { repository: releaseRepo([
        { id: "r1", isDraft: false, publishedAt: "2026-07-18T00:00:00Z", tagName: "v1" },
        { id: "unpublished", isDraft: false, publishedAt: null, tagName: "none" },
      ]), rateLimit: graphLimit() } });
    }});
    const metrics = await client.getAuxMetrics("owner/repo", "release/v1", new Date("2026-07-19T12:00:00Z"));
    expect(metrics).toMatchObject({ commits30d: 6, prTotal: 9, prOpen: 2, prMerged: 4,
      issuesTotal: 7, issuesOpen: 3, issuesClosed: 4, releasesCount: 100, latestReleaseTag: "v1" });
    expect(graphPage).toBe(2);
  });

  it("does not let an exhausted Core resource delay GraphQL", async () => {
    const sleep = vi.fn(async () => undefined);
    let coreCalls = 0;
    const client = new GitHubHttpClient({ token: "t", sleep, now: () => new Date(1_000), maxWaitMs: 5_000, fetcher: async (input) => {
      if (new URL(String(input)).pathname === "/graphql") {
        return json({ data: { repository: graphRepo([], false, null), rateLimit: graphLimit() } });
      }
      coreCalls += 1;
      return json(validRepo, coreCalls === 1 ? { "X-RateLimit-Resource": "core", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "2" } : {});
    }});
    await client.getCoreMetrics("owner/repo", new Date("2026-07-19T12:00:00Z"));
    await client.getAuxMetrics("owner/repo", "release/v1", new Date("2026-07-19T12:00:00Z"));
    expect(sleep).not.toHaveBeenCalled();
    await client.getCoreMetrics("owner/repo", new Date("2026-07-19T12:00:00Z"));
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("reads Core in one request without a README side request", async () => {
    const fetcher = vi.fn(async () => json(validRepo));
    const core = await new GitHubHttpClient({ token: "t", fetcher }).getCoreMetrics("owner/repo", new Date("2026-07-19T12:00:00Z"));
    expect(core).toMatchObject({ stars: 10, forks: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preflights Core and GraphQL independently and returns zero GraphQL capacity without waiting", async () => {
    const sleep = vi.fn(async () => undefined);
    const client = new GitHubHttpClient({ token: "t", sleep, fetcher: async () => json({ resources: {
      search: { remaining: 30, reset: 1_800_000_000 },
      core: { remaining: 50, reset: 1_800_000_000 },
      graphql: { remaining: 0, reset: 1_800_000_100 },
    } }) });
    await expect(client.getMetricRateLimit()).resolves.toEqual({
      coreRemaining: 50, graphqlRemaining: 0, resetAt: new Date(1_800_000_000_000),
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects capture times outside GitHub's supported timestamp range before a request", async () => {
    const fetcher = vi.fn(async () => json(validRepo));
    const client = new GitHubHttpClient({ token: "t", fetcher });
    await expect(client.getCoreMetrics("owner/repo", new Date("2100-01-01T00:00:00Z")))
      .rejects.toMatchObject({ code: "invalid_capture_time" });
    await expect(client.getAuxMetrics("owner/repo", "main", new Date("1969-12-31T23:59:59Z")))
      .rejects.toMatchObject({ code: "invalid_capture_time" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats an empty default branch as zero commits and rejects every GraphQL partial error", async () => {
    const empty = new GitHubHttpClient({ token: "t", fetcher: async () => json({ data: { repository: {
      ...graphRepo([], false, null), defaultBranchRef: null,
    }, rateLimit: graphLimit() } }) });
    expect((await empty.getAuxMetrics("owner/repo", "release/v1", new Date("2026-07-19T12:00:00Z"))).commits30d).toBe(0);
    for (const [extensions, code] of [[{ type: "RATE_LIMITED" }, "rate_limit"], [{ type: "NOT_FOUND" }, "not_found"], [{ type: "OTHER" }, "response_invalid"]] as const) {
      const client = new GitHubHttpClient({ token: "t", fetcher: async () => json({
        data: { repository: graphRepo([], false, null), rateLimit: graphLimit() },
        errors: [{ message: "must not surface", extensions }],
      }) });
      await expect(client.getAuxMetrics("owner/repo", "release/v1", new Date("2026-07-19T12:00:00Z"))).rejects.toMatchObject({ code });
    }
  });

  it("maps a null repository to not_found but rejects a null GraphQL data envelope", async () => {
    const missing = new GitHubHttpClient({ token: "t", fetcher: async () => json({
      data: { repository: null, rateLimit: graphLimit() },
    }) });
    await expect(missing.getAuxMetrics("owner/repo", "main", new Date("2026-07-19T12:00:00Z")))
      .rejects.toMatchObject({ code: "not_found" });
    const broken = new GitHubHttpClient({ token: "t", fetcher: async () => json({ data: null }) });
    await expect(broken.getAuxMetrics("owner/repo", "main", new Date("2026-07-19T12:00:00Z")))
      .rejects.toMatchObject({ code: "response_invalid" });
  });

  it("stops after the bounded ten-page release traversal", async () => {
    let page = 0;
    const client = new GitHubHttpClient({ token: "t", fetcher: async () => {
      page += 1;
      const node = { id: `release-${page}`, isDraft: false, isPrerelease: false,
        publishedAt: "2026-07-18T00:00:00Z", tagName: `v${page}` };
      return json({ data: { repository: page === 1
        ? graphRepo([node], true, `cursor-${page}`)
        : { ...releaseRepo([node]), releases: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: `cursor-${page}` } } },
        rateLimit: graphLimit() } });
    } });
    await expect(client.getAuxMetrics("owner/repo", "release/v1", new Date("2026-07-19T12:00:00Z")))
      .rejects.toMatchObject({ code: "pagination_limit_exceeded" });
    expect(page).toBe(10);
  });

  it("fails closed on overlapping release pages", async () => {
    let page = 0;
    const duplicated = { id: "same", isDraft: false, publishedAt: "2026-07-18T00:00:00Z", tagName: "v1" };
    const client = new GitHubHttpClient({ token: "t", fetcher: async () => json({ data: {
      repository: ++page === 1 ? graphRepo([duplicated], true, "next") : releaseRepo([duplicated]),
      rateLimit: graphLimit(),
    } }) });
    await expect(client.getAuxMetrics("owner/repo", "release/v1", new Date("2026-07-19T12:00:00Z"))).rejects.toMatchObject({ code: "response_invalid" });
  });
});

const validRepo = {
  id: 1, node_id: "R_1", name: "repo", full_name: "owner/repo", private: false,
  owner: { id: 2, login: "owner", type: "User", html_url: "https://github.com/owner", avatar_url: "https://avatars.githubusercontent.com/u/2" },
  html_url: "https://github.com/owner/repo", description: "d", fork: false, created_at: "2026-07-01T00:00:00Z",
  pushed_at: "2026-07-19T00:00:00Z", homepage: null, stargazers_count: 10, forks_count: 1,
  archived: false, disabled: false, visibility: "public", mirror_url: null, is_template: false,
  default_branch: "release/v1", language: null, license: null, topics: [],
};
function graphRepo(nodes: unknown[], hasNextPage: boolean, endCursor: string | null) {
  return { nameWithOwner: "owner/repo", defaultBranchRef: { name: "release/v1", target: { history: { totalCount: 6 } } },
    pullsTotal: { totalCount: 9 }, pullsOpen: { totalCount: 2 }, pullsClosed: { totalCount: 3 }, pullsMerged: { totalCount: 4 },
    issuesTotal: { totalCount: 7 }, issuesOpen: { totalCount: 3 }, issuesClosed: { totalCount: 4 },
    releases: { nodes, pageInfo: { hasNextPage, endCursor } } };
}
function releaseRepo(nodes: unknown[]) {
  return { nameWithOwner: "owner/repo", defaultBranchRef: { name: "release/v1" }, releases: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } };
}
function graphLimit() { return { cost: 1, remaining: 100, resetAt: "2026-07-20T00:00:00Z" }; }
function json(body: unknown, headers: Record<string, string> = {}) { return new Response(JSON.stringify(body), { status: 200, headers }); }
