import { describe, expect, it } from "vitest";

import { buildDailyReport, type DailyReportItem } from "../../../src/reports/daily-report.js";

function candidate(index: number): DailyReportItem {
  return {
    productId: `p${index}`,
    name: `Product ${index}`,
    repositoryUrl: `https://github.com/acme/p${index}`,
    homepageUrl: index === 0 ? "https://p0.example" : null,
    capturedAt: "2026-07-19T00:00:00.000Z",
    conclusion: `结论${index}`,
    score: { attentionScore: 100 - index, githubMomentum: 80 - index, xAttention: 20 },
    ranks: { overall: index + 1, daily: index === 0 ? 1 : null, weekly: null, monthly: null },
    githubFacts: { stars: 1000 - index, deltaStars24h: 20 - index },
    xFacts: { status: "success_with_results" as const, posts: 3, authors: 3, sentiment: { positive: 2 } },
    representativePosts: [
      { url: `https://x.com/u/status/${index}a`, category: "real_usage" },
      { url: `https://x.com/u/status/${index}b`, category: "independent_analysis" },
      { url: `https://x.com/u/status/${index}c`, category: "project_launch" },
    ],
    risks: ["24 小时样本较短"],
  };
}

describe("buildDailyReport", () => {
  it("sorts deterministically, returns Top 10 and limits evidence links without mutating input", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(index)).reverse();
    const before = structuredClone(candidates);

    const report = buildDailyReport({
      dataCutoffAt: new Date("2026-07-19T00:00:00Z"),
      facts: { scannedRepos: 12, eligibleProducts: 12 },
      candidates,
      summaryClaims: [],
      evaluationProductIds: ["p0"],
      baselineProductIds: ["p1"],
    });

    expect(report.items.map((item) => item.productId)).toEqual(Array.from({ length: 10 }, (_, index) => `p${index}`));
    expect(report.items.every((item) => item.representativePosts.length === 2)).toBe(true);
    expect(candidates).toEqual(before);
  });

  it("keeps only individually supported claims and excludes affiliated authors from independence", () => {
    const report = buildDailyReport({
      dataCutoffAt: new Date("2026-07-19T00:00:00Z"),
      facts: { scannedRepos: 1 },
      candidates: [candidate(0)],
      summaryClaims: [
        { text: "跨项目采用在增加", evidence: [{ productId: "p0", authorId: "a", isProjectAffiliated: true }, { productId: "p1", authorId: "b", isProjectAffiliated: true }] },
        { text: "独立用户讨论集中在部署", evidence: ["a", "b", "c"].map((authorId) => ({ productId: "p0", authorId, isProjectAffiliated: false })) },
        { text: "项目方集中发布", evidence: ["owner-a", "owner-b", "owner-c"].map((authorId) => ({ productId: "p0", authorId, isProjectAffiliated: true })) },
      ],
      evaluationProductIds: [],
      baselineProductIds: [],
    });

    expect(report.platformSummary).toBe("跨项目采用在增加；独立用户讨论集中在部署");
    expect(report.platformSummary).not.toContain("项目方集中发布");
  });

  it("does not present unavailable X as zero discussion", () => {
    const unavailable: DailyReportItem = {
      ...candidate(0),
      xFacts: { status: "unavailable", posts: 0, authors: 0, sentiment: { positive: 0 } },
    };
    const empty: DailyReportItem = {
      ...candidate(1),
      xFacts: { status: "success_empty", posts: 0, authors: 0, sentiment: { positive: 0 } },
    };

    const report = buildDailyReport({ dataCutoffAt: new Date("2026-07-19T00:00:00Z"), facts: {}, candidates: [unavailable, empty], summaryClaims: [], evaluationProductIds: [], baselineProductIds: [] });

    expect(report.items[0].xFacts.status).toBe("unavailable");
    expect(report.items[1].xFacts.status).toBe("success_empty");
  });
});
