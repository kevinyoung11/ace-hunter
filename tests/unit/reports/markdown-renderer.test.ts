import { describe, expect, it } from "vitest";

import { renderDailyReport, renderProductReport } from "../../../src/reports/markdown-renderer.js";
import { buildProductReport } from "../../../src/reports/product-report.js";

const baseItem = {
  productId: "p",
  name: "Promising",
  repositoryUrl: "https://github.com/acme/promising",
  homepageUrl: "https://promising.example",
  capturedAt: "2026-07-19T00:00:00.000Z",
  conclusion: "值得继续观察",
  score: { attentionScore: 80, githubMomentum: 70, xAttention: null },
  ranks: { overall: 1, daily: 3, weekly: null, monthly: null },
  githubFacts: { stars: 100, forks: 10, deltaStars24h: 20 },
  xFacts: { status: "unavailable" as const, sentiment: { positive: 1 } },
  representativePosts: [{ url: "https://x.com/user/status/1", category: "real_usage" }],
  risks: ["X 数据源在截止时间前未完成"],
};

describe("renderDailyReport", () => {
  it("renders replayable cutoff, coverage, ranks, scores, URLs and explicit model labels", () => {
    const text = renderDailyReport({ dataCutoffAt: "2026-07-19T00:00:00.000Z", facts: { scannedRepos: 20, eligibleProducts: 1 }, platformSummary: "开发者关注部署", evaluationProductIds: ["p"], baselineProductIds: [], items: [baseItem] });
    expect(text).toContain("2026-07-19T00:00:00.000Z");
    expect(text).toContain("扫描仓库：20");
    expect(text).toContain("Attention Score：80");
    expect(text).toContain("总榜 #1");
    expect(text).toContain("日榜 #3");
    expect(text).toContain("https://github.com/acme/promising");
    expect(text).toContain("https://promising.example");
    expect(text).toContain("X 数据不可用");
    expect(text).toContain("情绪（模型判断）");
    expect(text).toContain("结论（模型判断）");
    expect(text).toContain("风险（基于事实）");
    expect(text).not.toMatch(/刷星|star fraud/i);
  });

  it("distinguishes a successful zero-result search from unavailable X", () => {
    const text = renderDailyReport({ dataCutoffAt: "2026-07-19T00:00:00.000Z", facts: {}, platformSummary: null, evaluationProductIds: [], baselineProductIds: [], items: [{ ...baseItem, xFacts: { status: "success_empty", posts: 0, authors: 0 } }] });
    expect(text).toContain("X 检索成功，相关讨论为 0");
    expect(text).not.toContain("X 数据不可用");
  });
});

describe("product report common contract", () => {
  it.each(["product_analysis", "realtime_observation"] as const)("builds and renders %s with the same fact structure", (outputType) => {
    const report = buildProductReport({ outputType, dataCutoffAt: new Date("2026-07-19T00:00:00Z"), status: outputType === "realtime_observation" ? "partial" : "complete", item: baseItem, missingSources: outputType === "realtime_observation" ? ["x"] : [] });
    expect(report.outputType).toBe(outputType);
    expect(report.item.githubFacts.stars).toBe(100);
    expect(report.item.xFacts.status).toBe("unavailable");
    const text = renderProductReport(report);
    expect(text).toContain(outputType === "product_analysis" ? "产品离线分析" : "产品实时观察");
    expect(text.includes("状态：partial")).toBe(outputType === "realtime_observation");
    expect(text.includes("缺失数据源：x")).toBe(outputType === "realtime_observation");
  });
});
