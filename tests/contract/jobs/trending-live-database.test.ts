import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { JobRunner } from "../../../src/jobs/job-runner.js";
import { collectGithubTrending } from "../../../src/jobs/collect-github-trending.js";
import { GitHubHttpClientFactory } from "../../../src/sources/github/github-http-client.js";
import { GitHubTrendingSource } from "../../../src/sources/trending/github-trending-source.js";
import type { TrendingPeriod, TrendingSource } from "../../../src/sources/trending/trending-source.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const liveEnabled = process.env.RUN_LIVE_TRENDING_DATABASE_CONTRACT === "1";

describe.skipIf(!liveEnabled)("live GitHub Trending database contract", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let migratorPool: Pool;
  let lockPool: Pool;

  beforeAll(async () => {
    const config = parseTestDatabaseConfig(process.env);
    ({ adminPool, runtimePool, migratorPool } = await createVerifiedTestPools({
      ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl,
      ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl,
      ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl,
    }));
    lockPool = new Pool({ connectionString: config.runtimeDatabaseUrl });
    await truncateFacts();
  });

  afterAll(async () => {
    if (!adminPool) return;
    await truncateFacts();
    await Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end(), lockPool.end()]);
  }, 30_000);

  it("runs each live period leader through JobRunner and persists linked products, repositories, core snapshots, and ranking batches", async () => {
    const token = process.env.ACE_HUNTER_GITHUB_TOKEN;
    if (!token) throw new Error("ACE_HUNTER_GITHUB_TOKEN is required for the live database contract");
    const runner = new JobRunner(runtimePool, { lockPool, loadedSecrets: [token] });
    const sourceFactory = new GitHubHttpClientFactory({ token, maxRequests: 500 });
    const liveTrending = new GitHubTrendingSource();
    const trendingSource: TrendingSource = {
      collect: async (period, language) => {
        const collection = await liveTrending.collect(period, language);
        return { ...collection, entries: collection.entries.slice(0, 1) };
      },
    };
    const scheduledFor = new Date("2026-07-19T22:37:00Z");

    for (const period of ["daily", "weekly", "monthly"] satisfies TrendingPeriod[]) {
      const outcome = await runner.run({
        name: "collect_github_trending",
        triggerType: "manual",
        scheduledFor,
        parameters: { period, language: "all", contract: "live" },
      }, async (context) => collectGithubTrending({ pool: runtimePool, sourceFactory, trendingSource }, {
        period,
        language: "all",
        scheduledFor: context.scheduledFor,
        runId: context.runId,
      }));
      expect(["success", "partial"]).toContain(outcome.status);
    }

    const batches = await runtimePool.query<{
      period: string;
      rows: number;
      attributed: number;
      linked: number;
      snapshotted: number;
    }>(`select t.period,count(*)::int rows,count(t.job_run_id)::int attributed,
          count(pr.product_id)::int linked,count(s.id)::int snapshotted
        from ace_hunter.github_trending_snapshots t
        join ace_hunter.product_repositories pr on pr.repository_id=t.repository_id and pr.is_primary
        join ace_hunter.repository_snapshots s on s.repository_id=t.repository_id
          and s.captured_at=t.captured_at and s.granularity='hourly'
       group by t.period order by t.period`);
    expect(batches.rows.map((row) => row.period)).toEqual(["daily", "monthly", "weekly"]);
    expect(batches.rows.every((row) => row.rows > 0 && row.attributed === row.rows && row.linked === row.rows && row.snapshotted === row.rows)).toBe(true);

    const facts = await runtimePool.query<{ invalid: number }>(`select count(*)::int invalid
        from ace_hunter.github_trending_snapshots t join ace_hunter.repositories r on r.id=t.repository_id
       where t.rank<1 or t.stars_in_period<0 or r.github_repo_id<=0 or r.full_name=''`);
    expect(facts.rows[0].invalid).toBe(0);
  }, 60_000);

  async function truncateFacts(): Promise<void> {
    await adminPool.query(`truncate ace_hunter.analysis_outputs,ace_hunter.product_x_posts,
      ace_hunter.github_trending_snapshots,ace_hunter.user_product_monitors,
      ace_hunter.repository_snapshots,ace_hunter.product_repositories,
      ace_hunter.job_runs,ace_hunter.repositories,ace_hunter.products cascade`);
  }
});
