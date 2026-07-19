import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  evaluateClosedCohorts,
  type XHumanReview,
} from "../../../src/jobs/evaluate-success.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const config = parseTestDatabaseConfig(process.env);
const now = new Date("2026-07-19T00:00:00Z");
const sourceRunId = "90000000-0000-4000-8000-000000000001";
const userId = "90000000-0000-4000-8000-000000000002";
let adminPool: Pool;
let runtimePool: Pool;
let migratorPool: Pool;
let nextRepositoryId = 1;
let nextTrendingRun = 1;

beforeAll(async () => {
  ({ adminPool, runtimePool, migratorPool } = await createVerifiedTestPools({
    ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl,
    ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl,
    ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl,
  }));
});

beforeEach(async () => {
  await adminPool.query(`truncate ace_hunter.analysis_outputs,ace_hunter.product_x_posts,
    ace_hunter.github_trending_snapshots,ace_hunter.repository_snapshots,
    ace_hunter.product_repositories,ace_hunter.repositories,ace_hunter.products,
    ace_hunter.job_runs cascade`);
  await adminPool.query("delete from auth.users");
  await adminPool.query("insert into auth.users(id) values($1)", [userId]);
  nextRepositoryId = 1;
  nextTrendingRun = 1;
  await seedEvaluationRun();
});

afterAll(async () => Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]));

describe("closed-cohort success evaluation", () => {
  it("evaluates only closed seven-day cohorts with leakage-free precision, lead time, on-time, and coverage", async () => {
    const products = await seedProducts(["a", "b", "c", "d"]);
    await seedReport("2026-07-01T00:00:00Z", [products.a.productId, products.b.productId],
      [products.b.productId, products.c.productId]);
    await seedReport("2026-07-18T00:00:00Z", [products.d.productId], [products.d.productId]);
    await seedTrending(products.a.repositoryId, "daily", "2026-07-03T00:00:00Z");
    await seedTrending(products.c.repositoryId, "weekly", "2026-07-02T00:00:00Z");
    await seedTrending(products.d.repositoryId, "daily", "2026-07-19T00:00:00Z");
    await seedGenerateRun("2026-07-01T00:30:00Z", "2026-07-01T00:44:00Z");

    const result = await evaluateClosedCohorts(runtimePool, now, { sourceJobRunId: sourceRunId });
    if (result.status !== "evaluated") throw new Error("expected evaluated result");

    expect(result).toMatchObject({
      status: "evaluated",
      cohortCount: 1,
      attentionPrecision: 0.5,
      baselinePrecision: 0.5,
      absolutePointDifference: 0,
      relativeLift: 0,
      reportOnTimeRate: 1,
      githubCoverageRate: 1,
      sourceJobRunId: sourceRunId,
      xReview: { status: "not_reviewed" },
      clickThroughRate: "not_measurable_in_v0_1",
    });
    expect(result.leadTimeHours).toEqual([48]);

    const reports = await runtimePool.query<{ period_end: Date; evaluation: Record<string, unknown> | null }>(
      `select period_end,structured_content->'evaluation' evaluation
         from ace_hunter.analysis_outputs where output_type='daily_report' order by period_end`,
    );
    expect(reports.rows[0].evaluation).toMatchObject({
      status: "evaluated",
      attentionPrecision: 0.5,
      baselinePrecision: 0.5,
      source_job_run_id: sourceRunId,
    });
    expect(reports.rows[1].evaluation).toBeNull();
    expect((await runtimePool.query(`select count(*)::int n from ace_hunter.analysis_outputs
      where output_type not in ('daily_report','product_analysis','realtime_observation')`)).rows[0].n).toBe(0);
  });

  it("marks the newest report as not_enough_history when no seven-day window has closed", async () => {
    const products = await seedProducts(["new"]);
    await seedReport("2026-07-18T00:00:00Z", [products.new.productId], [products.new.productId]);

    const result = await evaluateClosedCohorts(runtimePool, now, { sourceJobRunId: sourceRunId });

    expect(result).toMatchObject({ status: "not_enough_history", cohortCount: 0, sourceJobRunId: sourceRunId });
    const evaluation = (await runtimePool.query<{ evaluation: Record<string, unknown> }>(
      "select structured_content->'evaluation' evaluation from ace_hunter.analysis_outputs",
    )).rows[0].evaluation;
    expect(evaluation).toEqual({
      status: "not_enough_history",
      evaluated_at: now.toISOString(),
      source_job_run_id: sourceRunId,
      oldest_eligible_at: "2026-07-25T00:00:00.000Z",
    });
  });

  it("counts lead time once from a product's first Top 10 appearance", async () => {
    const products = await seedProducts(["repeat-top"]);
    await seedReport("2026-07-01T00:00:00Z", [products["repeat-top"].productId],
      [products["repeat-top"].productId]);
    await seedReport("2026-07-02T00:00:00Z", [products["repeat-top"].productId],
      [products["repeat-top"].productId]);
    await seedTrending(products["repeat-top"].repositoryId, "daily", "2026-07-03T00:00:00Z");

    const result = await evaluateClosedCohorts(runtimePool, now, { sourceJobRunId: sourceRunId });
    if (result.status !== "evaluated") throw new Error("expected evaluated result");

    expect(result.cohortCount).toBe(2);
    expect(result.leadTimeHours).toEqual([48]);
  });

  it("excludes a Trending row whose source job completed after the seven-day outcome window closed", async () => {
    const products = await seedProducts(["late"]);
    await seedReport("2026-07-01T00:00:00Z", [products.late.productId], [products.late.productId]);
    await seedTrending(products.late.repositoryId, "daily", "2026-07-03T00:00:00Z", "2026-07-03T00:00:00Z", "2026-07-10T00:00:00Z");
    const result = await evaluateClosedCohorts(runtimePool, now, { sourceJobRunId: sourceRunId });
    if (result.status !== "evaluated") throw new Error("expected evaluated result");
    expect(result.attentionPrecision).toBe(0);
    expect(result.leadTimeHours).toEqual([]);
  });

  it("stores only aggregate results for a validated 50-post X review", async () => {
    const products = await seedProducts(["review"]);
    await seedReport("2026-07-01T00:00:00Z", [products.review.productId], [products.review.productId]);
    const review = await seedXHumanReview(products.review, 50, {
      relevanceCorrect: 46,
      spamDuplicateCorrect: 44,
    });

    const result = await evaluateClosedCohorts(runtimePool, now, {
      sourceJobRunId: sourceRunId,
      xReview: review,
    });
    if (result.status !== "evaluated") throw new Error("expected evaluated result");

    expect(result.xReview).toEqual({
      status: "reviewed",
      sampleSize: 50,
      relevanceAccuracy: 0.92,
      spamDuplicateAccuracy: 0.88,
      sentimentAccuracy: 0.9,
      reviewer: "reviewer@example.com",
      reviewedAt: "2026-07-18T08:00:00.000Z",
    });
    const stored = (await runtimePool.query<{ review: Record<string, unknown> }>(
      "select structured_content#>'{evaluation,xReview}' review from ace_hunter.analysis_outputs",
    )).rows[0].review;
    expect(stored).toEqual(result.xReview);
    expect(JSON.stringify(stored)).not.toContain("post-");

    await evaluateClosedCohorts(runtimePool, new Date("2026-07-20T00:00:00Z"), { sourceJobRunId: sourceRunId });
    const preserved = (await runtimePool.query<{ review: Record<string, unknown> }>(
      "select structured_content#>'{evaluation,xReview}' review from ace_hunter.analysis_outputs",
    )).rows[0].review;
    expect(preserved).toEqual(result.xReview);
  });

  it("measures analyze, observe, follow, and seven-day repeats from real outputs and audited runs", async () => {
    const products = await seedProducts(["behavior"]);
    await seedReport("2026-07-01T00:00:00Z", [products.behavior.productId], [products.behavior.productId]);
    await seedUserOutput("product_analysis", products.behavior.productId, "2026-07-02T01:00:00Z");
    await seedUserOutput("realtime_observation", products.behavior.productId, "2026-07-03T01:00:00Z");
    await runtimePool.query(`insert into ace_hunter.job_runs
      (job_name,trigger_type,scheduled_for,parameters,status,started_at,completed_at,
       items_expected,items_succeeded,items_failed,items_skipped,idempotency_key)
      values('user_follow','user','2026-07-04T01:00:00Z',$1,'success','2026-07-04T01:00:00Z',
        '2026-07-04T01:00:00Z',1,1,0,0,'behavior-follow')`, [JSON.stringify({ userId, productId: products.behavior.productId })]);
    await seedUserOutput("product_analysis", products.behavior.productId, "2026-07-09T00:00:01Z");

    const result = await evaluateClosedCohorts(runtimePool, now, { sourceJobRunId: sourceRunId });
    if (result.status !== "evaluated") throw new Error("expected evaluated result");

    expect(result.userBehavior).toEqual({ analyze: 1, observe: 1, follow: 1, repeatWithin7d: 1 });
    expect(result.clickThroughRate).toBe("not_measurable_in_v0_1");
  });
});

async function seedEvaluationRun(): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.job_runs
    (id,job_name,trigger_type,scheduled_for,parameters,status,started_at,idempotency_key)
    values($1,'evaluate_success','schedule',$2,'{}','running',$2,'evaluate-source')`, [sourceRunId, now]);
}

async function seedProducts(names: string[]): Promise<Record<string, { productId: string; repositoryId: string }>> {
  const result: Record<string, { productId: string; repositoryId: string }> = {};
  for (const name of names) {
    const productId = (await runtimePool.query<{ id: string }>(
      "insert into ace_hunter.products(name,status) values($1,'active') returning id", [name],
    )).rows[0].id;
    const repositoryId = (await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
      (github_repo_id,owner_login,name,full_name,repo_url,github_created_at,is_fork,is_archived,is_template,is_mirror,status)
      values($1,'owner',$2,$3,$4,'2026-06-01T00:00:00Z',false,false,false,false,'active') returning id`,
    [nextRepositoryId++, name, `owner/${name}`, `https://github.com/owner/${name}`])).rows[0].id;
    await runtimePool.query(`insert into ace_hunter.product_repositories
      (product_id,repository_id,role,is_primary,link_source) values($1,$2,'primary',true,'test')`,
    [productId, repositoryId]);
    result[name] = { productId, repositoryId };
  }
  return result;
}

async function seedReport(cutoffIso: string, recommended: string[], baseline: string[]): Promise<void> {
  const cutoff = new Date(cutoffIso);
  const sourceCandidates = [...new Set([...recommended, ...baseline])].map((productId, index) => ({
    productId,
    stars: 100 + index,
    stars24hAgo: 90 + index,
    repoAgeHours: 72,
  }));
  await runtimePool.query(`insert into ace_hunter.analysis_outputs
    (output_type,period_start,period_end,data_cutoff_at,status,title,structured_content,
     rendered_markdown,analysis_version,trigger_type,started_at,completed_at)
    values('daily_report',$1::timestamptz - interval '1 day',$1,$1,'complete','daily',$2,'# daily','report-v1',
      'schedule',$1,$1)`, [cutoff, JSON.stringify({
    report: {
      dataCutoffAt: cutoff.toISOString(),
      evaluationProductIds: recommended,
      baselineProductIds: baseline,
      items: [],
    },
    sourceCandidates,
  })]);
}

async function seedTrending(
  repositoryId: string,
  period: "daily" | "weekly",
  capturedAt: string,
  createdAt = capturedAt,
  completedAt = createdAt,
): Promise<void> {
  const run = await runtimePool.query<{ id: string }>(`insert into ace_hunter.job_runs
    (job_name,trigger_type,scheduled_for,parameters,status,started_at,completed_at,
     items_expected,items_succeeded,items_failed,items_skipped,idempotency_key)
    values('collect_github_trending','schedule',$1,$2,'success',$1,$3,1,1,0,0,$4) returning id`,
  [capturedAt, JSON.stringify({ period }), completedAt, `trending-${nextTrendingRun++}`]);
  await runtimePool.query(`insert into ace_hunter.github_trending_snapshots
    (repository_id,period,language,captured_at,rank,source_url,collection_status,created_at,job_run_id)
    values($1,$2,'all',$3,1,'https://github.com/trending','success',$4,$5)`,
  [repositoryId, period, capturedAt, createdAt, run.rows[0].id]);
}

async function seedGenerateRun(scheduledFor: string, completedAt: string): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.job_runs
    (job_name,trigger_type,scheduled_for,parameters,status,started_at,completed_at,
     items_expected,items_succeeded,items_failed,items_skipped,idempotency_key)
    values('generate_report','schedule',$1,'{}','success',$1,$2,1,1,0,0,$3)`,
  [scheduledFor, completedAt, `generate:${scheduledFor}`]);
}

async function seedXHumanReview(
  product: { productId: string; repositoryId: string },
  size: number,
  correct: { relevanceCorrect: number; spamDuplicateCorrect: number },
): Promise<XHumanReview> {
  const samples: XHumanReview["samples"] = [];
  for (let index = 0; index < size; index += 1) {
    const postId = `post-${index}`;
    await runtimePool.query(`insert into ace_hunter.product_x_posts
      (product_id,repository_id,x_post_id,post_type,author_id,author_username,content,post_url,x_created_at)
      values($1,$2,$3,'original',$3,$3,$3,$4,'2026-07-01T01:00:00Z')`,
    [product.productId, product.repositoryId, postId, `https://x.com/a/status/${index}`]);
    samples.push({
      postId,
      relevanceCorrect: index < correct.relevanceCorrect,
      spamDuplicateCorrect: index < correct.spamDuplicateCorrect,
      sentimentCorrect: index < 45,
    });
  }
  return {
    reviewer: "reviewer@example.com",
    reviewedAt: new Date("2026-07-18T08:00:00Z"),
    samples,
  };
}

async function seedUserOutput(
  outputType: "product_analysis" | "realtime_observation",
  productId: string,
  at: string,
): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.analysis_outputs
    (output_type,user_id,product_id,period_start,period_end,data_cutoff_at,status,title,
     structured_content,rendered_markdown,analysis_version,trigger_type,idempotency_key,started_at,completed_at)
    values($1,$2,$3,$4,$4,$4,'complete','user','{}','# user','v1',$5,$6,$4,$4)`, [
    outputType, userId, productId, at,
    outputType === "realtime_observation" ? "realtime" : "manual",
    outputType === "realtime_observation" ? `${outputType}:${at}` : null,
  ]);
}
