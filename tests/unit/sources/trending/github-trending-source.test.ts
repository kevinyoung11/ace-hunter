import { describe, expect, it, vi } from "vitest";
import { GitHubTrendingSource } from "../../../../src/sources/trending/github-trending-source.js";

const validHtml = "<article class='Box-row'><h2><a href='/a/b'>a/b</a></h2><span class='d-inline-block float-sm-right'>12 stars today</span></article>";

describe("GitHubTrendingSource", () => {
  it("uses only the canonical GitHub Trending URL and disables redirects", async () => {
    const fetcher = vi.fn(async () => new Response(validHtml, { headers: { "content-type": "text/html; charset=utf-8" } }));
    const source = new GitHubTrendingSource({ fetcher });
    await expect(source.collect("daily", "all")).resolves.toMatchObject({
      entries: [{ rank: 1, fullName: "a/b", starsInPeriod: 12 }],
      sourceUrl: "https://github.com/trending?since=daily",
    });
    expect(fetcher).toHaveBeenCalledWith(new URL("https://github.com/trending?since=daily"), expect.objectContaining({
      method: "GET", redirect: "error", headers: expect.objectContaining({ "Accept-Language": "en-US,en;q=0.9" }),
    }));
  });

  it("rejects language-specific collection because v0 is all-language only", async () => {
    const source = new GitHubTrendingSource({ fetcher: async () => new Response(validHtml, { headers: { "content-type": "text/html" } }) });
    await expect(source.collect("daily", "c++")).rejects.toMatchObject({ code: "trending_validation_error" });
    await expect(source.collect("daily", "../login")).rejects.toMatchObject({ code: "trending_validation_error" });
  });

  it("rejects redirects, non-HTML, declared oversize, and streamed oversize bodies", async () => {
    const redirected = new GitHubTrendingSource({ fetcher: async () => Object.defineProperties(
      new Response(validHtml, { headers: { "content-type": "text/html" } }),
      { redirected: { value: true }, url: { value: "https://evil.example/" } },
    ) });
    await expect(redirected.collect("daily", "all")).rejects.toMatchObject({ code: "trending_redirect" });
    await expect(new GitHubTrendingSource({ fetcher: async () => new Response("{}", { headers: { "content-type": "application/json" } }) }).collect("daily", "all"))
      .rejects.toMatchObject({ code: "trending_response_invalid" });
    await expect(new GitHubTrendingSource({ maxBodyBytes: 10, fetcher: async () => new Response(validHtml, { headers: { "content-type": "text/html", "content-length": "999" } }) }).collect("daily", "all"))
      .rejects.toMatchObject({ code: "trending_response_too_large" });
    await expect(new GitHubTrendingSource({ maxBodyBytes: 10, fetcher: async () => new Response("12345678901", { headers: { "content-type": "text/html" } }) }).collect("daily", "all"))
      .rejects.toMatchObject({ code: "trending_response_too_large" });
  });

  it("rejects invalid UTF-8 and excessively fragmented streams", async () => {
    const invalidUtf8 = new GitHubTrendingSource({
      fetcher: async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "text/html" } }),
    });
    await expect(invalidUtf8.collect("daily", "all")).rejects.toMatchObject({ code: "trending_response_invalid" });

    let chunks = 0;
    const fragmentedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 4_097) controller.enqueue(new Uint8Array([0x20]));
        else controller.close();
      },
    });
    const fragmented = new GitHubTrendingSource({ maxBodyBytes: 10_000, fetcher: async () => new Response(fragmentedBody, { headers: { "content-type": "text/html" } }) });
    await expect(fragmented.collect("daily", "all")).rejects.toMatchObject({ code: "trending_response_too_fragmented" });
  });

  it("enforces timeout during the fetch and streaming phases", async () => {
    const fetchTimeout = new GitHubTrendingSource({ timeoutMs: 1, fetcher: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
    await expect(fetchTimeout.collect("daily", "all")).rejects.toMatchObject({ code: "timeout" });

    const body = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const streamTimeout = new GitHubTrendingSource({ timeoutMs: 1, fetcher: async () => new Response(body, { headers: { "content-type": "text/html" } }) });
    await expect(streamTimeout.collect("daily", "all")).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps HTTP failures to safe source errors", async () => {
    await expect(new GitHubTrendingSource({ fetcher: async () => new Response("busy", { status: 429 }) }).collect("daily", "all"))
      .rejects.toMatchObject({ code: "rate_limit" });
    await expect(new GitHubTrendingSource({ fetcher: async () => new Response("down", { status: 503 }) }).collect("daily", "all"))
      .rejects.toMatchObject({ code: "source_unavailable" });
    await expect(new GitHubTrendingSource({ fetcher: async () => new Response("forbidden", { status: 403 }) }).collect("daily", "all"))
      .rejects.toMatchObject({ code: "source_unavailable" });
    await expect(new GitHubTrendingSource({ fetcher: async () => new Response("limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } }) }).collect("daily", "all"))
      .rejects.toMatchObject({ code: "rate_limit" });
  });
});
