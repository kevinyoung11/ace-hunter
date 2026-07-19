import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { generateReport, type GenerateReportDependencies } from "../../../src/jobs/generate-report.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const config = parseTestDatabaseConfig(process.env);
const cutoff = new Date("2026-07-19T00:00:00Z");
let adminPool: Pool;
let runtimePool: Pool;
let migratorPool: Pool;

beforeAll(async () => {
  ({ adminPool, runtimePool, migratorPool } = await createVerifiedTestPools({
    ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl,
    ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl,
    ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl,
  }));
});

beforeEach(async () => {
  await adminPool.query("truncate ace_hunter.analysis_outputs cascade");
});

afterAll(async () => Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]));

describe("daily report generation", () => {
  it("persists one replayable Top 10, preserves evaluation, and freezes the requested cutoff", async () => {
    const deps = dependencies();
    const first = await generateReport(deps, cutoff);
    expect(first.report.dataCutoffAt).toBe(cutoff.toISOString());
    expect(first.report.items).toHaveLength(10);
    expect(first.report.items.every((item) => item.representativePosts.length <= 2)).toBe(true);
    expect(first.markdown).toContain(cutoff.toISOString());
    expect(first.markdown).toContain("https://github.com/owner/repo-0");
    expect(first.markdown).toContain("日榜 #1");
    expect(first.report.evaluationProductIds).toEqual(
      first.report.items.map((item) => item.productId).filter((productId) => productId !== "p0"),
    );
    expect(first.report.evaluationProductIds).toHaveLength(9);
    expect(first.report.baselineProductIds).toEqual(Array.from({ length: 10 }, (_, index) => `p${index + 1}`));

    const evaluation = { status: "evaluated", evaluated_at: "2026-07-26T00:00:00Z", cohort: ["p0"] };
    await runtimePool.query(`update ace_hunter.analysis_outputs
      set structured_content=structured_content || jsonb_build_object('evaluation',$2::jsonb)
      where id=$1`, [first.id, JSON.stringify(evaluation)]);

    const rerun = await generateReport(dependencies({
      xRunStatus: "unavailable",
      starsOffset: 1,
      summaryText: "未来模型生成了不同结论",
    }), cutoff);
    expect(rerun.id).toBe(first.id);
    expect(rerun.markdown).toBe(first.markdown);
    expect(rerun.report.items[0].capturedAt).toBe("2026-07-18T23:45:00.000Z");
    const stored = await runtimePool.query<{
      structured_content: Record<string, unknown>;
      rendered_markdown: string;
      data_cutoff_at: Date;
    }>(`select structured_content,rendered_markdown,data_cutoff_at
        from ace_hunter.analysis_outputs where id=$1`, [first.id]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].structured_content.evaluation).toEqual(evaluation);
    expect((stored.rows[0].structured_content.report as { items: unknown[] }).items).toHaveLength(10);
    expect(stored.rows[0].rendered_markdown).toBe(rerun.markdown);
    expect(stored.rows[0].data_cutoff_at).toEqual(cutoff);
    expect((await runtimePool.query("select count(*)::int count from ace_hunter.analysis_outputs")).rows[0].count).toBe(1);
  });

  it("stores unavailable X as partial without converting it to zero discussion", async () => {
    const result = await generateReport(dependencies({ xRunStatus: "unavailable" }), cutoff);
    expect(result.status).toBe("partial");
    expect(result.report.facts.xCoveredRepos).toBe(0);
    expect(result.report.items[0].xFacts.status).toBe("unavailable");
    expect(result.markdown).toContain("X 数据不可用");
    expect(result.markdown).not.toContain("X 讨论数：0");
    expect(result.report.items[0].representativePosts).toEqual([]);
  });

  it("rejects fabricated model evidence and noncanonical daily cutoffs", async () => {
    const fabricated = dependencies();
    fabricated.summaryClaims = async () => [{
      text: "伪造的平台趋势",
      evidence: [0, 1, 2].map((index) => ({
        productId: `fake-${index}`,
        authorId: `fake-author-${index}`,
        isProjectAffiliated: false,
      })),
    }];
    expect((await generateReport(fabricated, cutoff)).report.platformSummary).toBeNull();
    await expect(generateReport(dependencies(), new Date("2026-07-19T00:05:00Z")))
      .rejects.toThrow("daily_report_cutoff_must_be_08_00_asia_shanghai");
  });
});

function dependencies(options: {
  xRunStatus?: "success" | "partial" | "unavailable";
  starsOffset?: number;
  summaryText?: string;
} = {}): GenerateReportDependencies {
  const starsOffset = options.starsOffset ?? 0;
  return {
    pool: runtimePool,
    now: () => new Date("2026-07-19T00:30:00Z"),
    loadXRunStatus: async () => options.xRunStatus ?? "success",
    loadCandidates: async (_pool, requestedCutoff) => {
      expect(requestedCutoff).toEqual(cutoff);
      return Array.from({ length: 12 }, (_, index) => ({
        productId: `p${index}`,
        repositoryId: `r${index}`,
        snapshotObservedAt: new Date("2026-07-18T23:45:00Z"),
        stars: 1200 - index + starsOffset,
        stars24hAgo: 1000 - index,
        repoAgeHours: 120,
        xStatus: options.xRunStatus === "unavailable" ? "unavailable" as const : "success_with_results" as const,
        xPosts: 12 - index,
        xAuthors: Math.min(3, 12 - index),
        xEngagement: 100 - index,
        trending: index === 0 ? ["daily" as const] : [],
        trendingRanks: index === 0 ? { daily: 1 } : {},
        candidateAtCutoff: true,
        firstTrendingAt: null,
        preTrendingEligible: index !== 0,
      }));
    },
    loadEvidence: async (_pool, productIds, requestedCutoff) => {
      expect(productIds).toHaveLength(12);
      expect(requestedCutoff).toEqual(cutoff);
      return new Map(productIds.map((productId, index) => [productId, {
        name: `Product ${index}`,
        description: `Description ${index}`,
        repoUrl: `https://github.com/owner/repo-${index}`,
        homepageUrl: null,
        representativePosts: [0, 1, 2].map((postIndex) => ({
          url: `https://x.com/author/status/${index}${postIndex}`,
          category: postIndex === 0 ? "real_usage" : postIndex === 1 ? "independent_analysis" : "project_launch",
          engagement: 100 - postIndex,
          createdAt: new Date(`2026-07-18T2${postIndex}:00:00Z`),
          authorId: `author-${index}-${postIndex}`,
          isProjectAffiliated: false,
          sentiment: "positive" as const,
        })),
      }]));
    },
    summaryClaims: async () => [{
      text: options.summaryText ?? "多个项目获得独立开发者关注",
      evidence: [0, 1, 2].map((index) => ({ productId: `p${index}`, authorId: `author-${index}-0`, isProjectAffiliated: false })),
    }],
  };
}
