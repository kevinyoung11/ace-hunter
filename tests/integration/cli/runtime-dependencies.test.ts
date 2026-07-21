import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool } from "pg";
import { createProgram, type CliExitCode } from "../../../src/cli/index.js";
import {
  createDatabaseCliDependencies,
  createLazyProductionCliRuntime,
  createReadonlySignalCliDependencies,
  loadProductFreshness,
  persistRealtimeObservation,
} from "../../../src/cli/runtime-dependencies.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const config = parseTestDatabaseConfig(process.env);
const userId = "10000000-0000-4000-8000-000000000001";
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
  await adminPool.query(`truncate ace_hunter.analysis_outputs,ace_hunter.product_x_posts,
    ace_hunter.user_product_monitors,ace_hunter.repository_snapshots,
    ace_hunter.product_repositories,ace_hunter.repositories,ace_hunter.products,
    ace_hunter.job_runs cascade`);
  await adminPool.query("delete from auth.users");
  await adminPool.query("insert into auth.users(id) values($1)", [userId]);
});
afterAll(async () => Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]));

it("executes stored report, analysis, and monitor commands against the runtime database", async () => {
  const product = await seedProduct("runtime-repo");
  await runtimePool.query(`insert into ace_hunter.analysis_outputs
    (output_type,period_start,period_end,data_cutoff_at,status,title,structured_content,
     rendered_markdown,analysis_version,trigger_type,started_at,completed_at)
    values('daily_report','2026-07-18T00:00:00Z','2026-07-19T00:00:00Z','2026-07-19T00:00:00Z',
      'complete','今日值得关注','{"report":{"items":[]}}','# 今日值得关注\n','report-v1','schedule',now(),now())`);

  const today = await invoke(["today"]);
  expect(today.stdout).toEqual(["# 今日值得关注\n"]);
  const todayJson = await invoke(["today", "--format", "json"]);
  expect(JSON.parse(todayJson.stdout[0])).toMatchObject({
    kind: "daily_report",
    status: "complete",
    dataCutoffAt: "2026-07-19T00:00:00.000Z",
  });
  expect((await invoke(["analyze", "owner/runtime-repo", "--format", "json"])).exitCodes).toEqual([]);
  expect((await runtimePool.query("select count(*)::int n from ace_hunter.analysis_outputs where output_type='product_analysis' and user_id=$1", [userId])).rows[0].n).toBe(1);

  expect((await invoke(["follow", "owner/runtime-repo"])).exitCodes).toEqual([]);
  expect((await invoke(["follow", "owner/runtime-repo"])).exitCodes).toEqual([]);
  const listed = await invoke(["list"]);
  expect(JSON.parse(listed.stdout[0]).monitors).toEqual([
    expect.objectContaining({ productId: product.productId, status: "active" }),
  ]);
  expect((await runtimePool.query("select count(*)::int n from ace_hunter.user_product_monitors")).rows[0].n).toBe(1);
  expect((await invoke(["unfollow", "owner/runtime-repo"])).exitCodes).toEqual([]);
  expect((await runtimePool.query("select status from ace_hunter.user_product_monitors")).rows[0].status).toBe("inactive");
  expect((await runtimePool.query("select job_name,parameters from ace_hunter.job_runs order by created_at,id")).rows)
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ job_name: "user_follow", parameters: { productId: product.productId, userId } }),
      expect.objectContaining({ job_name: "user_unfollow", parameters: { productId: product.productId, userId } }),
    ]));
});

it("returns potential and verified trending facts through the actual command path", async () => {
  const product = await seedProduct("signal-repo");
  const potential = await invoke(["potential", "--rule", "3d", "--format", "json"]);
  expect(potential.exitCodes).toEqual([]);
  expect(JSON.parse(potential.stdout[0])).toMatchObject({
    kind: "potential_repositories",
    rule: "3d",
    generatedAt: "2026-07-19T00:30:00.000Z",
    items: [{ fullName: "owner/signal-repo", stars: 100, matchedRules: ["3d"] }],
  });

  const runId = (await runtimePool.query<{ id: string }>(`insert into ace_hunter.job_runs
    (job_name,trigger_type,scheduled_for,status,started_at,completed_at,
      items_expected,items_succeeded,items_failed,items_skipped,idempotency_key)
    values('collect_github_trending','schedule','2026-07-19T00:00:00Z','success',
      '2026-07-19T00:00:00Z','2026-07-19T00:20:00Z',1,1,0,0,'cli-trending') returning id`)).rows[0].id;
  await runtimePool.query(`insert into ace_hunter.github_trending_snapshots
    (repository_id,period,language,captured_at,rank,stars_in_period,source_url,collection_status,job_run_id)
    values($1,'daily','all','2026-07-19T00:10:00Z',1,40,
      'https://github.com/trending?since=daily','success',$2)`, [product.repositoryId, runId]);

  const trending = await invoke(["trending", "daily", "--limit", "all", "--format", "json"]);
  expect(trending.exitCodes).toEqual([]);
  expect(JSON.parse(trending.stdout[0])).toMatchObject({
    kind: "trending_lists",
    period: "daily",
    generatedAt: "2026-07-19T00:30:00.000Z",
    lists: [{
      period: "daily",
      status: "available",
      capturedAt: "2026-07-19T00:10:00.000Z",
      items: [{ fullName: "owner/signal-repo", rank: 1, stars: 100, starsInPeriod: 40 }],
    }],
  });
});

it("starts read-only commands without GitHub, X, model, or user credentials", async () => {
  await seedProduct("readonly-repo");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: CliExitCode[] = [];
  const io = {
    stdout: (value: string) => stdout.push(value),
    stderr: (value: string) => stderr.push(value),
    exit: (code: CliExitCode) => exitCodes.push(code),
  };
  const runtime = createLazyProductionCliRuntime({
    NODE_ENV: "test",
    ACE_HUNTER_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl,
  }, io);
  try {
    await createProgram(runtime.dependencies).parseAsync([
      "node", "ace-hunter", "potential", "--format", "json",
    ]);
    expect(exitCodes).toEqual([]);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0])).toMatchObject({
      kind: "potential_repositories",
      items: [expect.objectContaining({ fullName: "owner/readonly-repo" })],
    });
  } finally {
    await runtime.close();
  }
});

it("fixes the database cutoff once per read-only invocation", async () => {
  await seedProduct("fixed-cutoff");
  let calls = 0;
  const dependencies = createReadonlySignalCliDependencies({
    pool: runtimePool,
    now: () => {
      calls += 1;
      return new Date("2026-07-19T00:30:00Z");
    },
  });
  await dependencies.potential({ rule: "all", limit: 20 });
  expect(calls).toBe(1);
});

it("does not call a collected-but-unanalyzed X result fresh", async () => {
  const product = await seedProduct("freshness");
  await runtimePool.query(`update ace_hunter.products set
    x_collection_status='success_with_results',x_last_success_at='2026-07-19T00:20:00Z',
    x_last_attempted_at='2026-07-19T00:20:00Z' where id=$1`, [product.productId]);
  await runtimePool.query(`insert into ace_hunter.product_x_posts
    (product_id,repository_id,x_post_id,post_type,author_id,author_username,content,post_url,x_created_at,
     relevance_score,is_duplicate,first_seen_at)
    values($1,$2,'pending','original','author','author','pending','https://x.com/a/status/1',
      '2026-07-19T00:10:00Z',0.9,false,'2026-07-19T00:20:00Z')`,
  [product.productId, product.repositoryId]);
  expect((await loadProductFreshness(runtimePool, product.productId)).xAt).toBeNull();
  await runtimePool.query("update ace_hunter.product_x_posts set analyzed_at='2026-07-19T00:21:00Z' where product_id=$1", [product.productId]);
  expect((await loadProductFreshness(runtimePool, product.productId)).xAt)
    .toEqual(new Date("2026-07-19T00:21:00Z"));
  await runtimePool.query("delete from ace_hunter.product_x_posts where product_id=$1", [product.productId]);
  await runtimePool.query("update ace_hunter.products set x_collection_status='success_empty' where id=$1", [product.productId]);
  expect((await loadProductFreshness(runtimePool, product.productId)).xAt)
    .toEqual(new Date("2026-07-19T00:20:00Z"));
});

it("includes facts written at the coherent realtime observation cutoff", async () => {
  const product = await seedProduct("realtime-cutoff");
  const cutoff = new Date("2026-07-19T00:30:00Z");
  await runtimePool.query(`insert into ace_hunter.repository_snapshots
    (repository_id,captured_at,granularity,stars,forks,collected_fields)
    values($1,$2,'realtime',222,12,jsonb_build_object('observed_at',$3::text))`,
  [product.repositoryId, cutoff, cutoff.toISOString()]);
  const id = await persistRealtimeObservation(runtimePool, {
    outputType: "realtime_observation",
    productId: product.productId,
    dataCutoffAt: cutoff,
    status: "partial",
    completedSources: ["github"],
    missingSources: ["x"],
    github: { succeeded: 1 },
    x: null,
  });
  const stored = await runtimePool.query<{ structured_content: { report: { item: { githubFacts: { stars: number }; capturedAt: string } } } }>(
    "select structured_content from ace_hunter.analysis_outputs where id=$1", [id],
  );
  expect(stored.rows[0].structured_content.report.item.githubFacts.stars).toBe(222);
  expect(stored.rows[0].structured_content.report.item.capturedAt).toBe(cutoff.toISOString());
});

it("does not guess ambiguous names and creates an unseen explicit GitHub URL once", async () => {
  await seedProduct("same", "Product Same");
  await seedProduct("same-two", "Product Same");
  const ambiguous = await invoke(["analyze", "Product Same", "--format", "json"]);
  expect(ambiguous.exitCodes).toEqual([2]);
  expect(JSON.parse(ambiguous.stdout[0]).candidates).toHaveLength(2);

  let creations = 0;
  const create = async (fullName: string) => {
    creations += 1;
    const existing = await runtimePool.query<{ product_id: string }>(`select pr.product_id
      from ace_hunter.repositories r join ace_hunter.product_repositories pr on pr.repository_id=r.id and pr.is_primary
      where lower(r.full_name)=lower($1)`, [fullName]);
    if (existing.rows[0]) return { productId: existing.rows[0].product_id };
    const seeded = await seedProduct(fullName.split("/")[1], fullName);
    return { productId: seeded.productId };
  };
  expect((await invoke(["analyze", "https://github.com/new/repo", "--format", "json"], create)).exitCodes).toEqual([]);
  expect((await invoke(["analyze", "https://github.com/new/repo", "--format", "json"], create)).exitCodes).toEqual([]);
  expect(creations).toBe(1);
  expect((await invoke(["analyze", "unknown plain name", "--format", "json"])).exitCodes).toEqual([]);
});

async function invoke(args: string[], createProductFromGithub?: (fullName: string) => Promise<{ productId: string }>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: CliExitCode[] = [];
  const dependencies = createDatabaseCliDependencies({
    pool: runtimePool,
    userId,
    now: () => new Date("2026-07-19T00:30:00Z"),
    createProductFromGithub,
    observeResolved: async () => ({ status: "partial", missingSources: ["x"] }),
    runJob: async (input) => ({ runId: "test-run", input }),
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      exit: (code) => exitCodes.push(code),
    },
  });
  await createProgram(dependencies).parseAsync(["node", "ace-hunter", ...args]);
  return { stdout, stderr, exitCodes };
}

async function seedProduct(repositoryName: string, productName = repositoryName): Promise<{ productId: string; repositoryId: string }> {
  const githubId = Number((await runtimePool.query("select count(*)::int n from ace_hunter.repositories")).rows[0].n) + 1;
  const repositoryId = (await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
    (github_repo_id,owner_login,name,full_name,description,repo_url,github_created_at,
     is_fork,is_archived,is_template,is_mirror,status)
    values($1,'owner',$2,$3,'description',$4,'2026-07-18T00:00:00Z',false,false,false,false,'active') returning id`,
  [githubId, repositoryName, productName.includes("/") ? productName : `owner/${repositoryName}`,
    `https://github.com/${productName.includes("/") ? productName : `owner/${repositoryName}`}`])).rows[0].id;
  const productId = (await runtimePool.query<{ id: string }>(`insert into ace_hunter.products(name,status)
    values($1,'active') returning id`, [productName])).rows[0].id;
  await runtimePool.query(`insert into ace_hunter.product_repositories
    (product_id,repository_id,role,is_primary,link_source) values($1,$2,'primary',true,'github')`,
  [productId, repositoryId]);
  await runtimePool.query(`insert into ace_hunter.repository_snapshots
    (repository_id,captured_at,granularity,stars,forks,collected_fields,created_at)
    values($1,'2026-07-19T00:00:00Z','hourly',100,10,
      '{"observed_at":"2026-07-19T00:00:00.000Z","metadata":{"name":"repo","repo_url":"https://github.com/owner/repo"}}',
      '2026-07-19T00:00:00Z')`,
  [repositoryId]);
  return { productId, repositoryId };
}
