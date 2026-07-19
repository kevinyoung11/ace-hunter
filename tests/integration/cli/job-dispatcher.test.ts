import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool } from "pg";
import { createJobDispatcher } from "../../../src/cli/job-dispatcher.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const config = parseTestDatabaseConfig(process.env);
let adminPool: Pool;
let runtimePool: Pool;
let migratorPool: Pool;
let lockPool: Pool;
beforeAll(async () => {
  ({ adminPool, runtimePool, migratorPool } = await createVerifiedTestPools({
    ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl,
    ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl,
    ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl,
  }));
  lockPool = new Pool({ connectionString: config.runtimeDatabaseUrl, max: 2 });
});
beforeEach(async () => {
  await adminPool.query("truncate ace_hunter.analysis_outputs,ace_hunter.job_runs,ace_hunter.repository_snapshots cascade");
});
afterAll(async () => Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end(), lockPool.end()]));

it("runs real retention and report jobs through durable JobRunner idempotently", async () => {
  const run = createJobDispatcher({
    pool: runtimePool,
    lockPool,
    loadedSecrets: [config.runtimeDatabaseUrl],
    githubSourceFactory: neverGithub,
    trendingSource: neverTrending,
    xSource: neverX,
    analyzer: { analyze: async () => [] },
  });
  const retention = await run({
    name: "retention",
    triggerType: "manual",
    scheduledFor: new Date("2026-07-19T02:45:00Z"),
    parameters: {},
  });
  expect(retention).toMatchObject({ kind: "job_run", status: "success", executed: true });
  const duplicate = await run({
    name: "retention",
    triggerType: "manual",
    scheduledFor: new Date("2026-07-19T02:45:00Z"),
    parameters: {},
  });
  expect(duplicate).toMatchObject({ runId: retention.runId, status: "success", executed: false });

  const report = await run({
    name: "generate_report",
    triggerType: "manual",
    scheduledFor: new Date("2026-07-19T00:30:00Z"),
    parameters: { cutoff_hour_utc: 0 },
  });
  expect(report).toMatchObject({ status: "success" });
  expect((await runtimePool.query("select status from ace_hunter.analysis_outputs where output_type='daily_report'")).rows[0].status)
    .toBe("partial");

  const evaluation = await run({
    name: "evaluate_success",
    triggerType: "manual",
    scheduledFor: new Date("2026-07-19T03:15:00Z"),
    parameters: {},
  });
  expect(evaluation).toMatchObject({ status: "success", executed: true });
  expect((await runtimePool.query(
    "select structured_content->'evaluation' evaluation from ace_hunter.analysis_outputs where output_type='daily_report'",
  )).rows[0].evaluation).toMatchObject({
    status: "not_enough_history",
    source_job_run_id: evaluation.runId,
  });

  const comments = await run({
    name: "collect_x_comments",
    triggerType: "manual",
    scheduledFor: new Date("2026-07-19T03:20:00Z"),
    parameters: {},
  });
  expect(comments).toMatchObject({ status: "success" });
  expect((await runtimePool.query("select parameters from ace_hunter.job_runs where id=$1", [comments.runId])).rows[0].parameters)
    .toMatchObject({ product_ids: [], root_post_ids: [] });
});

it("persists a failed job and rejects so the CLI exits nonzero", async () => {
  const run = createJobDispatcher({
    pool: runtimePool,
    lockPool,
    loadedSecrets: [config.runtimeDatabaseUrl],
    githubSourceFactory: neverGithub,
    trendingSource: neverTrending,
    xSource: neverX,
    analyzer: null,
  });
  await expect(run({
    name: "unsupported_job",
    triggerType: "manual",
    scheduledFor: new Date("2026-07-19T03:00:00Z"),
    parameters: {},
  })).rejects.toMatchObject({ code: "job_failed" });
  expect((await runtimePool.query(
    "select status,error_summary from ace_hunter.job_runs where job_name='unsupported_job'",
  )).rows[0]).toMatchObject({ status: "failed", error_summary: "validation_error: unsupported job name" });
});

const neverGithub = { openOperation: () => { throw new Error("unexpected github"); } };
const neverTrending = { collect: async () => { throw new Error("unexpected trending"); } };
const neverX = {
  capabilities: () => ({ recentSearchDays: 7, replies: true }),
  assertAuthenticated: async () => { throw new Error("unexpected x"); },
  searchPosts: async () => [],
  searchReplies: async () => [],
  getArticle: async () => ({ articleText: "" }),
};
