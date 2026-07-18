import { describe, expect, it, vi } from "vitest";
import { GitHubHttpClient } from "../../../../src/sources/github/github-http-client.js";

const validRepo = {
  id: 1, node_id: "R_1", name: "repo", full_name: "owner/repo", private: false,
  owner: { id: 2, login: "owner", type: "User", html_url: "https://github.com/owner", avatar_url: "https://avatars.githubusercontent.com/u/2" },
  html_url: "https://github.com/owner/repo", description: "d", fork: false,
  created_at: "2026-07-18T00:00:00Z", pushed_at: "2026-07-19T00:00:00Z", homepage: null,
  stargazers_count: 10, forks_count: 1, archived: false, disabled: false, visibility: "public",
  mirror_url: null, is_template: false, default_branch: "main", language: null, license: null, topics: [],
};

describe("GitHubHttpClient", () => {
  it("uses fixed origin, encoded search qualifiers, and mandatory headers", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/rate_limit")) return response({ resources: { search: { remaining: 30, reset: 2_000_000_000 } } });
      expect(new URL(url).origin).toBe("https://api.github.com");
      const query = new URL(url).searchParams.get("q")!;
      expect(query).toContain("created:2026-07-01T00:00:00Z..2026-07-01T23:59:59Z");
      expect(query).toContain("stars:10..20");
      expect(query).toContain("is:public");
      expect(query).not.toContain("fork:false");
      expect(init?.headers).toMatchObject({
        Accept: "application/vnd.github+json", Authorization: "Bearer super-secret",
        "User-Agent": "ace-hunter/0.1", "X-GitHub-Api-Version": "2022-11-28",
      });
      return response({ total_count: 1, incomplete_results: false, items: [validRepo] });
    });
    const client = new GitHubHttpClient({ token: "super-secret", fetcher, now: () => new Date("2026-07-01T00:00:00Z") });
    expect((await client.searchRepositories({ from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T23:59:59Z"), minStars: 10, maxStars: 20 }, 1)).repositories).toHaveLength(1);
  });

  it("rejects malformed responses and never exposes token or response body", async () => {
    const client = new GitHubHttpClient({ token: "super-secret", fetcher: async () => response({ secret: "body-secret" }) });
    await expect(client.getRateLimit()).rejects.toThrow(/github_response_invalid/);
    await expect(client.getRateLimit()).rejects.not.toThrow(/super-secret|body-secret/);
  });

  it("rejects private repositories and validates full names", async () => {
    const client = new GitHubHttpClient({ token: "t", fetcher: async () => response({ ...validRepo, private: true, visibility: "private" }) });
    await expect(client.getRepository("owner/repo")).rejects.toThrow(/private_repository/);
    await expect(client.getRepository("owner/repo/extra")).rejects.toThrow(/invalid_full_name/);
  });

  it("drops token-visible private hits instead of admitting them", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/rate_limit")
      ? response({ resources: { search: { remaining: 30, reset: 2_000_000_000 } } })
      : response({ total_count: 3, incomplete_results: false, items: [
        validRepo,
        { ...validRepo, id: 2, node_id: "R_2", private: true, visibility: "private" },
        { ...validRepo, id: 3, node_id: "R_3", disabled: true },
      ] }));
    const result = await new GitHubHttpClient({ token: "t", fetcher }).searchRepositories({
      from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T23:59:59Z"), minStars: 10,
    }, 1);
    expect(result.repositories.map((repo) => repo.githubRepoId)).toEqual([1]);
  });

  it("bounds rate-limit waiting by request budget", async () => {
    const sleep = vi.fn(async () => undefined);
    const client = new GitHubHttpClient({
      token: "t", sleep, now: () => new Date("2026-07-01T00:00:00Z"), maxWaitMs: 1_000,
      fetcher: async () => new Response("limited-secret", { status: 429, headers: { "Retry-After": "10" } }),
    });
    await expect(client.getRateLimit()).rejects.toThrow(/github_rate_limit_budget_exceeded/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses Link as pagination authority", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/rate_limit")
      ? response({ resources: { search: { remaining: 30, reset: 2_000_000_000 } } })
      : response({ total_count: 1_000, incomplete_results: false, items: [validRepo] }, {
        Link: '<https://api.github.com/search/repositories?q=x&page=2>; rel="next", <https://api.github.com/search/repositories?q=x&page=10>; rel="last"',
      }));
    const page = await new GitHubHttpClient({ token: "t", fetcher }).searchRepositories({
      from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T23:59:59Z"), minStars: 10,
    }, 1);
    expect(page).toMatchObject({ hasNextPage: true, nextPage: 2 });
  });

  it("retries an incomplete search once then fails typed", async () => {
    let searchCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/rate_limit")
      ? response({ resources: { search: { remaining: 30, reset: 2_000_000_000 } } })
      : (searchCalls++, response({ total_count: 1, incomplete_results: true, items: [validRepo] })));
    await expect(new GitHubHttpClient({ token: "t", fetcher }).searchRepositories({
      from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-01T23:59:59Z"), minStars: 10,
    }, 1)).rejects.toMatchObject({ code: "search_incomplete" });
    expect(searchCalls).toBe(2);
  });

  it("does not retry an ordinary forbidden response", async () => {
    const fetcher = vi.fn(async () => new Response("forbidden secret", { status: 403 }));
    await expect(new GitHubHttpClient({ token: "t", fetcher }).getRateLimit()).rejects.toThrow(/github_http_status_403/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats README 404 as false and other errors as unknown", async () => {
    const missing = new GitHubHttpClient({ token: "t", fetcher: async () => new Response("", { status: 404 }) });
    expect(await missing.hasReadme("owner/repo")).toBe(false);
    const forbidden = new GitHubHttpClient({ token: "t", fetcher: async () => new Response("", { status: 403 }) });
    await expect(forbidden.hasReadme("owner/repo")).rejects.toThrow(/github_http_status_403/);
  });
});

function response(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}
