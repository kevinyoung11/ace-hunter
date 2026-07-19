import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadReportCandidates, loadXRunStatus } from "../../../src/reports/report-data.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const cutoff = new Date("2026-07-19T00:00:00Z");
const config = parseTestDatabaseConfig(process.env);
let adminPool: Pool;
let runtimePool: Pool;
let migratorPool: Pool;
let nextGitHubId = 1;

beforeAll(async () => {
  ({ adminPool, runtimePool, migratorPool } = await createVerifiedTestPools({
    ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl,
    ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl,
    ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl,
  }));
});

beforeEach(async () => {
  await adminPool.query(`truncate ace_hunter.analysis_outputs,ace_hunter.product_x_posts,
    ace_hunter.github_trending_snapshots,ace_hunter.user_product_monitors,
    ace_hunter.repository_snapshots,ace_hunter.product_repositories,
    ace_hunter.repositories,ace_hunter.products,ace_hunter.job_runs cascade`);
  await adminPool.query("delete from auth.users");
  nextGitHubId = 1;
});

afterAll(async () => Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]));

describe("cutoff-safe report candidates", () => {
  it("derives the global X run status only from the latest completed eligible collection", async () => {
    expect(await loadXRunStatus(runtimePool, cutoff)).toBe("unavailable");
    await jobRun("success", "2026-07-18T20:00:00Z", "2026-07-18T20:05:00Z", "success");
    expect(await loadXRunStatus(runtimePool, cutoff)).toBe("success");
    await jobRun("partial-success", "2026-07-18T21:00:00Z", "2026-07-18T21:05:00Z", "success");
    await jobRun("partial-failed", "2026-07-18T21:00:00Z", "2026-07-18T21:06:00Z", "failed");
    await jobRun("future-completion", "2026-07-18T22:00:00Z", "2026-07-19T00:01:00Z", "failed");
    await jobRun("future-schedule", "2026-07-19T01:00:00Z", "2026-07-18T23:00:00Z", "failed");
    await jobRun("running", "2026-07-18T23:30:00Z", null, "running");
    await jobRun("late-old-success", "2026-07-18T19:00:00Z", "2026-07-18T23:30:00Z", "success");
    expect(await loadXRunStatus(runtimePool, cutoff)).toBe("partial");
    await jobRun("failed", "2026-07-18T23:40:00Z", "2026-07-18T23:45:00Z", "failed");
    expect(await loadXRunStatus(runtimePool, cutoff)).toBe("unavailable");
  });

  it("uses only Primary repositories and recomputes candidate and current Trending facts at cutoff", async () => {
    const candidate = await seedProduct("candidate", "2026-07-14T00:00:00Z");
    await snapshot(candidate.repositoryId, "2026-07-18T23:50:00Z", 150, ["stale_bucket"]);
    await snapshot(candidate.repositoryId, "2026-07-18T23:59:00Z", 999, [], "2026-07-19T00:30:00Z");
    const secondary = await seedRepository("candidate-secondary", "2026-07-18T00:00:00Z");
    await linkRepository(candidate.productId, secondary, false);
    await snapshot(secondary, "2026-07-18T23:59:00Z", 999_999, ["age_1d_stars_10"]);

    const oldOnly = await seedProduct("old-only", "2026-05-01T00:00:00Z");
    await snapshot(oldOnly.repositoryId, "2026-07-18T23:50:00Z", 5, ["age_30d_stars_1000"]);
    await trend(oldOnly.repositoryId, "daily", "2026-07-17T00:00:00Z", 1, "success");
    await trend(candidate.repositoryId, "daily", "2026-07-18T23:00:00Z", 1, "success");

    const currentTrend = await seedProduct("current-trend", "2026-05-01T00:00:00Z");
    await snapshot(currentTrend.repositoryId, "2026-07-18T23:50:00Z", 5);
    await trend(currentTrend.repositoryId, "weekly", "2026-07-18T22:00:00Z", 1, "success");
    await trend(oldOnly.repositoryId, "weekly", "2026-07-18T23:00:00Z", 1, "partial");

    const lateTrend = await seedProduct("late-trend", "2026-05-01T00:00:00Z");
    await snapshot(lateTrend.repositoryId, "2026-07-18T23:50:00Z", 5);
    const lateTrendRun = await jobRun("late-trending-run", "2026-07-18T23:30:00Z", "2026-07-19T00:05:00Z", "success");
    await trend(lateTrend.repositoryId, "monthly", "2026-07-18T23:30:00Z", 1, "success",
      "2026-07-18T23:31:00Z", lateTrendRun);

    const monitorOnly = await seedProduct("monitor-only", "2026-05-01T00:00:00Z");
    await snapshot(monitorOnly.repositoryId, "2026-07-18T23:50:00Z", 1);
    const userId = "10000000-0000-4000-8000-000000000001";
    await adminPool.query("insert into auth.users(id) values($1)", [userId]);
    await runtimePool.query(`insert into ace_hunter.user_product_monitors(user_id,product_id,status)
      values($1,$2,'active')`, [userId, monitorOnly.productId]);

    const rows = await loadReportCandidates(runtimePool, cutoff);
    expect(rows.map((row) => row.productId).sort()).toEqual(
      [candidate.productId, currentTrend.productId].sort(),
    );
    expect(rows.find((row) => row.productId === candidate.productId)).toMatchObject({
      repositoryId: candidate.repositoryId,
      stars: 150,
      candidateAtCutoff: true,
      trending: ["daily"],
    });
    expect(rows.find((row) => row.productId === currentTrend.productId)).toMatchObject({
      candidateAtCutoff: false,
      trending: ["weekly"],
    });
  });

  it("builds a pre-Trending evaluation set without leaking a future first appearance", async () => {
    const appeared = await seedProduct("already-trended", "2026-07-14T00:00:00Z");
    const future = await seedProduct("future-trending", "2026-07-14T00:00:00Z");
    const never = await seedProduct("never-trending", "2026-07-14T00:00:00Z");
    for (const repositoryId of [appeared.repositoryId, future.repositoryId, never.repositoryId]) {
      await snapshot(repositoryId, "2026-07-18T23:45:00Z", 120);
    }
    await trend(appeared.repositoryId, "monthly", "2026-07-17T00:00:00Z", 1, "success");
    await trend(future.repositoryId, "daily", "2026-07-19T01:00:00Z", 1, "success");

    const rows = await loadReportCandidates(runtimePool, cutoff);
    expect(rows.find((row) => row.productId === appeared.productId)).toMatchObject({
      firstTrendingAt: new Date("2026-07-17T00:00:00Z"),
      preTrendingEligible: false,
    });
    expect(rows.find((row) => row.productId === future.productId)).toMatchObject({
      firstTrendingAt: null,
      preTrendingEligible: true,
      trending: [],
    });
    expect(rows.find((row) => row.productId === never.productId)).toMatchObject({
      firstTrendingAt: null,
      preTrendingEligible: true,
    });

    const futureCreated = await seedProduct("future-created-repo", "2026-07-19T01:00:00Z");
    await snapshot(futureCreated.repositoryId, "2026-07-18T23:45:00Z", 1_000);
    await trend(futureCreated.repositoryId, "weekly", "2026-07-18T23:30:00Z", 1, "success");
    expect((await loadReportCandidates(runtimePool, cutoff)).some((row) => row.productId === futureCreated.productId))
      .toBe(false);
  });

  it("uses the nearest 24-hour reference within 90 minutes and cutoff-safe relevant X originals", async () => {
    const product = await seedProduct("signals", "2026-07-14T00:00:00Z", "success_with_results");
    await snapshot(product.repositoryId, "2026-07-18T23:55:00Z", 150);
    await snapshot(product.repositoryId, "2026-07-19T00:01:00Z", 9_999);
    await snapshot(product.repositoryId, "2026-07-17T22:20:00Z", 90);
    await snapshot(product.repositoryId, "2026-07-17T23:30:00Z", 100);
    await snapshot(product.repositoryId, "2026-07-18T00:40:00Z", 110);

    await xPost(product.productId, "included", {
      authorId: "author-a", likes: 1, reposts: 2, quotes: 3, replies: 4, bookmarks: 5, views: 9_999,
    });
    await xPost(product.productId, "same-author", { authorId: "author-a", likes: 10 });
    await xPost(product.productId, "article", { postType: "article", authorId: "author-b", likes: 20 });
    await xPost(product.productId, "comment", { postType: "comment", inReplyToPostId: "included", likes: 100 });
    await xPost(product.productId, "duplicate", { isDuplicate: true, likes: 100 });
    await xPost(product.productId, "irrelevant", { relevance: 0.59, likes: 100 });
    await xPost(product.productId, "future-created", { xCreatedAt: "2026-07-19T00:01:00Z", likes: 100 });
    await xPost(product.productId, "future-analyzed", { analyzedAt: "2026-07-19T00:01:00Z", likes: 100 });
    await xPost(product.productId, "future-metrics", { metricsUpdatedAt: "2026-07-19T00:01:00Z", likes: 100 });

    const row = (await loadReportCandidates(runtimePool, cutoff))[0];
    expect(row).toMatchObject({
      productId: product.productId,
      stars: 150,
      stars24hAgo: 100,
      xStatus: "success_with_results",
      xPosts: 3,
      xAuthors: 2,
      xEngagement: 45,
    });

    const outsideWindow = await seedProduct("outside-window", "2026-07-14T00:00:00Z");
    await snapshot(outsideWindow.repositoryId, "2026-07-18T23:50:00Z", 120);
    await snapshot(outsideWindow.repositoryId, "2026-07-17T22:29:59Z", 90);
    expect((await loadReportCandidates(runtimePool, cutoff))
      .find((candidate) => candidate.productId === outsideWindow.productId)?.stars24hAgo).toBeNull();

    await runtimePool.query(`update ace_hunter.products set x_last_attempted_at='2026-07-19T01:00:00Z',
      x_collection_status='unavailable' where id=$1`, [product.productId]);
    await jobRun("signals-success", "2026-07-18T22:00:00Z", "2026-07-18T22:05:00Z", "success",
      product.productId, 3);
    expect((await loadReportCandidates(runtimePool, cutoff))
      .find((candidate) => candidate.productId === product.productId)?.xStatus).toBe("success_with_results");

    const historicalEmpty = await seedProduct("historical-empty", "2026-07-14T00:00:00Z", "success_empty");
    await snapshot(historicalEmpty.repositoryId, "2026-07-18T23:50:00Z", 120);
    await xPost(historicalEmpty.productId, "older-result", { xCreatedAt: "2026-07-17T00:00:00Z" });
    await jobRun("historical-empty-success", "2026-07-18T22:00:00Z", "2026-07-18T22:05:00Z", "success",
      historicalEmpty.productId, 0);
    await runtimePool.query(`update ace_hunter.products set x_last_attempted_at='2026-07-19T01:00:00Z',
      x_collection_status='unavailable' where id=$1`, [historicalEmpty.productId]);
    expect((await loadReportCandidates(runtimePool, cutoff))
      .find((candidate) => candidate.productId === historicalEmpty.productId)?.xStatus).toBe("success_empty");
  });

  it("rejects integer facts that cannot be represented exactly in JavaScript", async () => {
    const product = await seedProduct("unsafe-stars", "2026-07-14T00:00:00Z");
    await runtimePool.query(`insert into ace_hunter.repository_snapshots
      (repository_id,captured_at,granularity,stars,collected_fields)
      values($1,'2026-07-18T23:00:00Z','hourly',9007199254740992,
        '{"observed_at":"2026-07-18T23:01:00.000Z"}')`, [product.repositoryId]);
    await expect(loadReportCandidates(runtimePool, cutoff)).rejects.toThrow("unsafe_report_numeric_value:stars");
  });
});

type SeededProduct = { productId: string; repositoryId: string };

async function seedProduct(
  name: string,
  githubCreatedAt: string,
  xStatus: "not_collected" | "success_with_results" | "success_empty" | "unavailable" = "not_collected",
): Promise<SeededProduct> {
  const repositoryId = await seedRepository(name, githubCreatedAt);
  const productId = (await runtimePool.query<{ id: string }>(`insert into ace_hunter.products
    (name,status,x_collection_status,x_last_attempted_at,x_last_success_at)
    values($1,'active',$2,case when $2='not_collected' then null else '2026-07-18T22:00:00Z'::timestamptz end,
      case when $2 in ('success_with_results','success_empty') then '2026-07-18T22:00:00Z'::timestamptz else null end)
    returning id`, [name, xStatus])).rows[0].id;
  await linkRepository(productId, repositoryId, true);
  return { productId, repositoryId };
}

async function seedRepository(name: string, githubCreatedAt: string): Promise<string> {
  const githubId = nextGitHubId++;
  return (await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
    (github_repo_id,owner_login,name,full_name,repo_url,github_created_at,is_fork,is_archived,is_template,is_mirror,status)
    values($1,'owner',$2,$3,$4,$5,false,false,false,false,'active') returning id`,
  [githubId, name, `owner/${name}`, `https://github.com/owner/${name}`, githubCreatedAt])).rows[0].id;
}

async function linkRepository(productId: string, repositoryId: string, primary: boolean): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.product_repositories
    (product_id,repository_id,role,is_primary,link_source) values($1,$2,$3,$4,'github')`,
  [productId, repositoryId, primary ? "primary" : "secondary", primary]);
}

async function snapshot(repositoryId: string, capturedAt: string, stars: number, buckets: string[] = [], observedAt = capturedAt): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.repository_snapshots
    (repository_id,captured_at,granularity,stars,candidate_buckets,collected_fields)
    values($1,$2,'hourly',$3,$4,jsonb_build_object('observed_at',$5::text))`, [repositoryId, capturedAt, stars, buckets, new Date(observedAt).toISOString()]);
}

async function trend(
  repositoryId: string,
  period: "daily" | "weekly" | "monthly",
  capturedAt: string,
  rank: number,
  status: "success" | "partial",
  createdAt = capturedAt,
  jobRunId: string | null = null,
): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.github_trending_snapshots
    (repository_id,period,language,captured_at,rank,source_url,collection_status,created_at,job_run_id)
    values($1,$2,'all',$3,$4,'https://github.com/trending',$5,$6,$7)`,
  [repositoryId, period, capturedAt, rank, status, createdAt, jobRunId]);
}

async function jobRun(
  key: string,
  scheduledFor: string,
  completedAt: string | null,
  status: "running" | "success" | "partial" | "failed",
  productId?: string,
  itemsExpected?: number,
): Promise<string> {
  const startedAt = new Date(scheduledFor).getTime() > new Date("2026-07-18T23:00:00Z").getTime()
    ? "2026-07-18T22:59:00Z"
    : scheduledFor;
  return (await runtimePool.query<{ id: string }>(`insert into ace_hunter.job_runs
    (job_name,trigger_type,scheduled_for,status,started_at,completed_at,idempotency_key,parameters,
     items_expected,items_succeeded,items_failed,items_skipped)
    values('collect_x_posts','schedule',$1,$2,$3,$4,$5,jsonb_build_object('productId',$6::text),
      $7,case when $2='success' then $7 else 0 end,case when $2 in ('partial','failed') then coalesce($7,1) else 0 end,0)
    returning id`,
  [scheduledFor, status, startedAt, completedAt, `report-test:${key}`, productId ?? null, itemsExpected ?? null])).rows[0].id;
}

type XOverrides = {
  authorId?: string;
  postType?: "original" | "article" | "comment";
  inReplyToPostId?: string | null;
  likes?: number;
  reposts?: number;
  quotes?: number;
  replies?: number;
  bookmarks?: number | null;
  views?: number | null;
  relevance?: number;
  isDuplicate?: boolean;
  xCreatedAt?: string;
  analyzedAt?: string;
  metricsUpdatedAt?: string;
};

async function xPost(productId: string, id: string, overrides: XOverrides = {}): Promise<void> {
  const postType = overrides.postType ?? "original";
  await runtimePool.query(`insert into ace_hunter.product_x_posts
    (product_id,x_post_id,in_reply_to_post_id,post_type,author_id,author_username,content,post_url,
     x_created_at,likes,reposts,quotes,replies,bookmarks,views,metrics_updated_at,relevance_score,
     is_duplicate,analyzed_at,first_seen_at)
    values($1,$2,$3,$4,$5,$5,$2,'https://x.com/user/status/'||$2,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'2026-07-18T21:00:00Z')`, [
    productId,
    id,
    postType === "comment" ? (overrides.inReplyToPostId ?? "root") : null,
    postType,
    overrides.authorId ?? `author-${id}`,
    overrides.xCreatedAt ?? "2026-07-18T20:00:00Z",
    overrides.likes ?? 0,
    overrides.reposts ?? 0,
    overrides.quotes ?? 0,
    overrides.replies ?? 0,
    overrides.bookmarks ?? null,
    overrides.views ?? null,
    overrides.metricsUpdatedAt ?? "2026-07-18T21:00:00Z",
    overrides.relevance ?? 0.9,
    overrides.isDuplicate ?? false,
    overrides.analyzedAt ?? "2026-07-18T22:00:00Z",
  ]);
}
