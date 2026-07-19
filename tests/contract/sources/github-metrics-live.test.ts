import { describe, expect, it } from "vitest";
import { GitHubHttpClientFactory } from "../../../src/sources/github/github-http-client.js";

const liveEnabled = process.env.RUN_LIVE_GITHUB_METRICS_CONTRACT === "1";
const token = process.env.ACE_HUNTER_GITHUB_TOKEN;

describe.skipIf(!liveEnabled)("live GitHub metrics contract", () => {
  it("reads real Core and GraphQL metrics with internally consistent totals", async () => {
    if (!token) throw new Error("ACE_HUNTER_GITHUB_TOKEN is required for the live metrics contract");
    const operation = new GitHubHttpClientFactory({ token, maxRequests: 20, timeoutMs: 30_000 }).openOperation();
    const capturedAt = new Date();
    try {
      const limit = await operation.getMetricRateLimit();
      expect(limit.coreRemaining).toBeGreaterThan(0);
      expect(limit.graphqlRemaining).toBeGreaterThan(0);
      const core = await operation.getCoreMetrics("github/docs", capturedAt);
      expect(core.metadata.fullName.toLowerCase()).toBe("github/docs");
      expect(core.stars).toBeGreaterThanOrEqual(0);
      expect(core.forks).toBeGreaterThanOrEqual(0);
      const aux = await operation.getAuxMetrics("github/docs", core.metadata.defaultBranch, capturedAt);
      expect(aux.capturedAt).toEqual(capturedAt);
      expect(aux.prTotal - aux.prOpen - aux.prMerged).toBeGreaterThanOrEqual(0);
      expect(aux.issuesTotal).toBe(aux.issuesOpen + aux.issuesClosed);
      expect(aux.releasesCount).toBeGreaterThanOrEqual(aux.latestReleaseAt === null ? 0 : 1);
      expect(aux.latestReleaseAt === null).toBe(aux.latestReleaseTag === null);
    } finally {
      await operation.close();
    }
  }, 60_000);
});
