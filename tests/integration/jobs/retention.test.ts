import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { compactSnapshots } from "../../../src/jobs/retention.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const config = parseTestDatabaseConfig(process.env);
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
beforeEach(async () => await adminPool.query("truncate ace_hunter.repository_snapshots,ace_hunter.job_runs,ace_hunter.repositories cascade"));
afterAll(async () => await Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]));

describe("snapshot retention", () => {
  it("atomically creates the newest daily survivor before deleting covered hourly facts older than the deterministic cutoff", async () => {
    await runtimePool.query("set timezone='America/Los_Angeles'");
    const repositoryId = await seedRepo();
    await seedSnapshot(repositoryId, "2026-04-19T02:00:00Z", 2);
    await seedSnapshot(repositoryId, "2026-04-19T23:00:00Z", 23);
    await seedSnapshot(repositoryId, "2026-04-20T00:00:00Z", 24);
    await seedSnapshot(repositoryId, "2026-04-20T12:34:56Z", 25);
    const result = await compactSnapshots(runtimePool, new Date("2026-07-19T12:34:56Z"));
    expect(result).toMatchObject({ snapshotsDeleted: 3 });
    const rows = await runtimePool.query("select granularity,captured_at,stars from ace_hunter.repository_snapshots order by captured_at,granularity");
    expect(rows.rows).toEqual([
      { granularity: "daily", captured_at: new Date("2026-04-19T00:00:00Z"), stars: "23" },
      { granularity: "daily", captured_at: new Date("2026-04-20T00:00:00Z"), stars: "24" },
      { granularity: "hourly", captured_at: new Date("2026-04-20T12:34:56Z"), stars: "25" },
    ]);
    await seedSnapshot(repositoryId, "2026-04-20T06:00:00Z", 26);
    expect((await compactSnapshots(runtimePool, new Date("2026-07-19T12:34:56Z"))).snapshotsDeleted).toBe(1);
    expect((await runtimePool.query("select stars from ace_hunter.repository_snapshots where granularity='daily' and captured_at='2026-04-20T00:00:00Z'")).rows[0].stars).toBe("26");
    expect((await compactSnapshots(runtimePool, new Date("2026-07-19T12:34:56Z"))).snapshotsDeleted).toBe(0);
    await runtimePool.query("set timezone='UTC'");
  });

  it("deletes only terminal old job runs and preserves parent links by nulling deleted ancestors", async () => {
    const old = new Date("2026-04-01T00:00:00Z");
    const parent = await seedRun("parent", old, "success");
    const child = await seedRun("child", new Date("2026-07-01T00:00:00Z"), "success", parent);
    const running = await seedRun("running", old, "running");
    const result = await compactSnapshots(runtimePool, new Date("2026-07-19T12:00:00Z"));
    expect(result.jobRunsDeleted).toBe(1);
    expect((await runtimePool.query("select id,parent_run_id,status from ace_hunter.job_runs order by job_name")).rows)
      .toEqual(expect.arrayContaining([{ id: child, parent_run_id: null, status: "success" }, { id: running, parent_run_id: null, status: "running" }]));
  });

  it("rolls back both daily insertion and deletion when compaction fails", async () => {
    const repositoryId = await seedRepo();
    await seedSnapshot(repositoryId, "2026-04-01T12:00:00Z", 1);
    await runtimePool.query(`insert into ace_hunter.repository_snapshots(repository_id,captured_at,granularity,stars,collected_fields)
      values($1,'2026-04-01T00:00:00Z','daily',99,'{"compacted_source_captured_at":"malformed"}')`, [repositoryId]);
    await expect(compactSnapshots(runtimePool, new Date("2026-07-19T12:00:00Z"))).rejects.toThrow();
    expect((await runtimePool.query("select granularity,stars from ace_hunter.repository_snapshots order by granularity")).rows)
      .toEqual([{ granularity: "daily", stars: "99" }, { granularity: "hourly", stars: "1" }]);
  });
});

async function seedRepo(): Promise<string> {
  return (await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
    (github_repo_id,owner_login,name,full_name,repo_url,default_branch,topics,has_readme,github_created_at,
     is_fork,is_archived,is_template,is_mirror,status)
    values(1,'owner','repo','owner/repo','https://github.com/owner/repo','main','[]',true,now(),false,false,false,false,'active') returning id`)).rows[0].id;
}
async function seedSnapshot(repositoryId: string, capturedAt: string, stars: number): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.repository_snapshots(repository_id,captured_at,granularity,stars,candidate_buckets,collected_fields)
    values($1,$2,'hourly',$3,'{}','{}')`, [repositoryId, capturedAt, stars]);
}
async function seedRun(name: string, at: Date, status: "running" | "success", parentRunId?: string): Promise<string> {
  return (await runtimePool.query<{ id: string }>(`insert into ace_hunter.job_runs
    (job_name,trigger_type,parent_run_id,scheduled_for,status,started_at,completed_at,idempotency_key,created_at)
    values($1,'schedule',$2,$3::timestamptz,$4,$3::timestamptz,case when $4::text='running' then null else $3::timestamptz end,$1,$3::timestamptz) returning id`,
  [name, parentRunId ?? null, at, status])).rows[0].id;
}
