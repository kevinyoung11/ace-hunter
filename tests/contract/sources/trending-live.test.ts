import { describe, expect, it } from "vitest";
import { GitHubHttpClientFactory } from "../../../src/sources/github/github-http-client.js";
import { GitHubTrendingSource } from "../../../src/sources/trending/github-trending-source.js";
import type { TrendingPeriod } from "../../../src/sources/trending/trending-source.js";

const liveEnabled = process.env.RUN_LIVE_TRENDING_CONTRACT === "1";

describe.skipIf(!liveEnabled)("live GitHub Trending contract", () => {
  it("collects all three periods and enriches each leading repository", async () => {
    const token = process.env.ACE_HUNTER_GITHUB_TOKEN;
    if (!token) throw new Error("ACE_HUNTER_GITHUB_TOKEN is required for live Trending contract tests");
    const trending = new GitHubTrendingSource();
    const operation = new GitHubHttpClientFactory({ token, maxRequests: 20 }).openOperation();
    try {
      await operation.getRateLimit();
      for (const period of ["daily", "weekly", "monthly"] satisfies TrendingPeriod[]) {
        const collection = await trending.collect(period, "all");
        expect(collection.entries.length).toBeGreaterThan(0);
        expect(collection.entries.map((entry) => entry.rank)).toEqual(collection.entries.map((_entry, index) => index + 1));
        expect(collection.entries.every((entry) => Number.isSafeInteger(entry.starsInPeriod) && entry.starsInPeriod >= 0)).toBe(true);
        const first = collection.entries[0];
        const repository = await operation.getRepository(first.fullName);
        expect(repository.fullName.toLowerCase()).toBe(first.fullName.toLowerCase());
        expect(repository.githubRepoId).toBeGreaterThan(0);
        expect(repository.stars).toBeGreaterThanOrEqual(0);
        expect(repository.forks).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await operation.close();
    }
  }, 60_000);
});
