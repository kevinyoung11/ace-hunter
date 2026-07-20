import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadTrendingLists } from "../../../src/reports/trending-list.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const now = new Date("2026-07-20T12:00:00.000Z");
const config = parseTestDatabaseConfig(process.env);
let adminPool: Pool;
let runtimePool: Pool;
let migratorPool: Pool;
let nextGitHubId = 1;
let nextKey = 1;

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
  nextGitHubId = 1;
  nextKey = 1;
});

afterAll(async () => Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]));

describe("GitHub Trending read model", () => {
  it("falls back to the latest terminal attributable complete batch", async () => {
    const oldOne = await seedRepository("old-one");
    const oldTwo = await seedRepository("old-two");
    await seedBatch({
      period: "daily", capturedAt: "2026-07-18T12:00:00Z",
      entries: [{ repositoryId: oldTwo, rank: 2 }, { repositoryId: oldOne, rank: 1 }],
    });

    const invalidCases: Array<Parameters<typeof seedBatch>[0]> = [
      { period: "daily", capturedAt: "2026-07-18T13:00:00Z", jobStatus: "running" },
      { period: "daily", capturedAt: "2026-07-18T14:00:00Z", jobStatus: "partial" },
      { period: "daily", capturedAt: "2026-07-18T15:00:00Z", jobStatus: "failed" },
      { period: "daily", capturedAt: "2026-07-18T16:00:00Z", collectionStatus: "partial" },
      { period: "daily", capturedAt: "2026-07-18T17:00:00Z", succeeded: 2 },
      { period: "daily", capturedAt: "2026-07-18T17:30:00Z", failed: 1 },
      { period: "daily", capturedAt: "2026-07-18T18:00:00Z", lineage: "null" },
      { period: "daily", capturedAt: "2026-07-18T19:00:00Z", lineage: "mixed" },
      { period: "daily", capturedAt: "2026-07-18T20:00:00Z", language: "typescript" },
      { period: "daily", capturedAt: "2026-07-18T20:30:00Z", jobName: "refresh_repo_metrics" },
      { period: "daily", capturedAt: "2026-07-18T21:00:00Z", completedAt: "2026-07-20T12:00:00.001Z" },
      { period: "daily", capturedAt: "2026-07-20T12:00:00.001Z" },
    ];
    for (const input of invalidCases) await seedBatch(input);

    const result = await loadTrendingLists(runtimePool, { now, period: "daily", limit: null });

    expect(result).toMatchObject({
      kind: "trending_lists",
      period: "daily",
      generatedAt: now.toISOString(),
      lists: [{
        period: "daily", status: "available", capturedAt: "2026-07-18T12:00:00.000Z", stale: true,
      }],
    });
    expect(result.lists[0].status === "available" && result.lists[0].items.map((item) => item.rank))
      .toEqual([1, 2]);
  });

  it("returns fixed independent sections, applies a per-section limit, and uses cutoff-safe Star facts", async () => {
    const dailyFirst = await seedRepository("daily-first", {
      description: "First project", homepageUrl: "https://first.example/demo",
    });
    const dailySecond = await seedRepository("daily-second");
    const weeklyFirst = await seedRepository("weekly-first");
    await seedBatch({
      period: "daily", capturedAt: "2026-07-19T00:00:00Z",
      entries: [
        { repositoryId: dailySecond, rank: 2, starsInPeriod: 20 },
        { repositoryId: dailyFirst, rank: 1, starsInPeriod: 30 },
      ],
    });
    await seedBatch({
      period: "weekly", capturedAt: "2026-07-19T23:00:00Z",
      entries: [
        { repositoryId: dailySecond, rank: 2, starsInPeriod: 200 },
        { repositoryId: weeklyFirst, rank: 1, starsInPeriod: 300 },
      ],
    });
    await seedSnapshot(dailyFirst, 100, "2026-07-20T10:00:00Z", "2026-07-20T11:00:00Z");
    await seedSnapshot(dailyFirst, 101, "2026-07-20T09:00:00Z", "2026-07-20T11:30:00Z");
    await seedSnapshot(dailyFirst, 999, "2026-07-20T12:00:00.001Z", "2026-07-20T11:59:00Z");
    await seedSnapshot(dailyFirst, 998, "2026-07-20T11:59:00Z", "2026-07-20T12:00:00.001Z");
    await seedSnapshot(dailyFirst, 997, "2026-07-20T11:58:00Z", "2026-07-20T11:58:00Z", "2026-07-20T12:00:00.001Z");
    await seedSnapshot(weeklyFirst, 500, "2026-07-20T11:45:00Z", null);

    const result = await loadTrendingLists(runtimePool, { now, period: "all", limit: 1 });

    expect(result.kind).toBe("trending_lists");
    expect(result.lists.map((list) => [list.period, list.status])).toEqual([
      ["daily", "available"], ["weekly", "available"], ["monthly", "unavailable"],
    ]);
    const daily = result.lists[0];
    const weekly = result.lists[1];
    expect(daily).toMatchObject({ status: "available", stale: false, sourceUrl: "https://github.com/trending?since=daily" });
    expect(weekly).toMatchObject({ status: "available", stale: false, sourceUrl: "https://github.com/trending?since=weekly" });
    if (daily.status !== "available" || weekly.status !== "available") throw new Error("expected available lists");
    expect(daily.items).toEqual([expect.objectContaining({
      rank: 1, name: "daily-first", fullName: "owner/daily-first", description: "First project",
      owner: "owner", repositoryUrl: "https://github.com/owner/daily-first",
      homepageUrl: "https://first.example/demo", stars: 101,
      starsCapturedAt: "2026-07-20T11:30:00.000Z", starsInPeriod: 30,
    })]);
    expect(weekly.items).toEqual([expect.objectContaining({
      rank: 1, name: "weekly-first", stars: 500,
      starsCapturedAt: "2026-07-20T11:45:00.000Z", starsInPeriod: 300,
    })]);
  });

  it("keeps missing Star facts nullable and marks stale strictly after 36 hours", async () => {
    const repositoryId = await seedRepository("no-snapshot");
    await seedBatch({ period: "daily", capturedAt: "2026-07-19T00:00:00Z", entries: [{ repositoryId, rank: 1 }] });
    await seedBatch({ period: "weekly", capturedAt: "2026-07-18T23:59:59.999Z", entries: [{ repositoryId, rank: 1 }] });

    const result = await loadTrendingLists(runtimePool, { now, period: "all", limit: null });
    const [daily, weekly] = result.lists;

    expect(daily).toMatchObject({ status: "available", stale: false, items: [{ stars: null, starsCapturedAt: null }] });
    expect(weekly).toMatchObject({ status: "available", stale: true, items: [{ stars: null, starsCapturedAt: null }] });
  });

  it("returns explicit not-found states for one missing period and for all missing periods", async () => {
    expect(await loadTrendingLists(runtimePool, { now, period: "monthly", limit: 20 })).toEqual({
      kind: "not_found", reason: "trending_unavailable", period: "monthly",
      generatedAt: now.toISOString(), lists: [{ period: "monthly", status: "unavailable" }],
    });
    expect(await loadTrendingLists(runtimePool, { now, period: "all", limit: 20 })).toEqual({
      kind: "not_found", reason: "trending_unavailable", period: "all",
      generatedAt: now.toISOString(),
      lists: [
        { period: "daily", status: "unavailable" },
        { period: "weekly", status: "unavailable" },
        { period: "monthly", status: "unavailable" },
      ],
    });
  });
});

type Period = "daily" | "weekly" | "monthly";
type JobStatus = "running" | "success" | "partial" | "failed";
type BatchSeed = {
  period: Period;
  capturedAt: string;
  language?: string;
  jobStatus?: JobStatus;
  collectionStatus?: "success" | "partial";
  completedAt?: string;
  succeeded?: number;
  failed?: number;
  jobName?: string;
  lineage?: "single" | "null" | "mixed";
  entries?: Array<{ repositoryId: string; rank: number; starsInPeriod?: number | null }>;
};

async function seedBatch(input: BatchSeed): Promise<void> {
  const entries = input.entries ?? [{ repositoryId: await seedRepository(`invalid-${nextKey}`), rank: 1 }];
  if (input.entries === undefined && input.lineage === "mixed") {
    entries.push({ repositoryId: await seedRepository(`invalid-${nextKey}-second`), rank: 2 });
  }
  const runOne = await seedJobRun({
    status: input.jobStatus ?? "success",
    completedAt: input.completedAt,
    succeeded: input.succeeded ?? entries.length,
    failed: input.failed,
    jobName: input.jobName,
  });
  const runTwo = input.lineage === "mixed"
    ? await seedJobRun({ status: "success", succeeded: 1 })
    : runOne;
  for (const [index, entry] of entries.entries()) {
    const jobRunId = input.lineage === "null" ? null : input.lineage === "mixed" && index > 0 ? runTwo : runOne;
    await runtimePool.query(`insert into ace_hunter.github_trending_snapshots
      (repository_id,period,language,captured_at,rank,stars_in_period,source_url,collection_status,job_run_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      entry.repositoryId, input.period, input.language ?? "all", input.capturedAt, entry.rank,
      entry.starsInPeriod ?? 10, `https://github.com/trending?since=${input.period}`,
      input.collectionStatus ?? "success", jobRunId,
    ]);
  }
}

async function seedJobRun(input: {
  status: JobStatus;
  completedAt?: string;
  succeeded: number;
  failed?: number;
  jobName?: string;
}): Promise<string> {
  const key = `trending-test-${nextKey++}`;
  const startedAt = "2026-07-18T00:00:00Z";
  const completedAt = input.status === "running" ? null : input.completedAt ?? "2026-07-20T11:00:00Z";
  return (await runtimePool.query<{ id: string }>(`insert into ace_hunter.job_runs
    (job_name,trigger_type,scheduled_for,parameters,status,started_at,completed_at,
      items_expected,items_succeeded,items_failed,items_skipped,idempotency_key)
    values($1,'schedule',$2,'{}'::jsonb,$3,$2,$4,$5,$5,$6,0,$7) returning id`,
  [input.jobName ?? "collect_github_trending", startedAt, input.status, completedAt,
    input.succeeded, input.failed ?? 0, key])).rows[0].id;
}

async function seedRepository(name: string, options: { description?: string; homepageUrl?: string } = {}): Promise<string> {
  return (await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
    (github_repo_id,owner_login,name,full_name,description,repo_url,homepage_url,github_created_at,
      is_fork,is_archived,is_template,is_mirror,status)
    values($1,'owner',$2,$3,$4,$5,$6,'2026-07-01T00:00:00Z',false,false,false,false,'active') returning id`, [
    nextGitHubId++, name, `owner/${name}`, options.description ?? null,
    `https://github.com/owner/${name}`, options.homepageUrl ?? null,
  ])).rows[0].id;
}

async function seedSnapshot(
  repositoryId: string,
  stars: number,
  capturedAt: string,
  observedAt: string | null,
  createdAt = capturedAt,
): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.repository_snapshots
    (repository_id,captured_at,granularity,stars,collected_fields,created_at)
    values($1,$2,'hourly',$3,$4::jsonb,$5)`, [
    repositoryId, capturedAt, stars,
    JSON.stringify(observedAt === null ? {} : { observed_at: new Date(observedAt).toISOString() }), createdAt,
  ]);
}
