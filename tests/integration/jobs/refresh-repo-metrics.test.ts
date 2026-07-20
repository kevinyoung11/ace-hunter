import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { refreshRepoMetrics } from "../../../src/jobs/refresh-repo-metrics.js";
import { SnapshotStore } from "../../../src/db/stores/snapshot-store.js";
import { GitHubSourceError, type AuxMetrics, type CoreMetrics, type GitHubMetricSourceOperation } from "../../../src/sources/github/github-source.js";
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
beforeEach(async () => {
  await adminPool.query(`truncate ace_hunter.analysis_outputs,ace_hunter.product_x_posts,
    ace_hunter.github_trending_snapshots,ace_hunter.user_product_monitors,
    ace_hunter.repository_snapshots,ace_hunter.product_repositories,
    ace_hunter.job_runs,ace_hunter.repositories,ace_hunter.products cascade`);
});
afterAll(async () => await Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]));

describe("refreshRepoMetrics", () => {
  it("returns before opening GitHub when no active repository exists", async () => {
    let opens = 0;
    const result = await refreshRepoMetrics({
      pool: runtimePool,
      sourceFactory: { openOperation() { opens += 1; throw new Error("must not open"); } },
      now: () => new Date("2026-07-19T12:40:00Z"),
    }, { scheduledFor: new Date("2026-07-19T12:37:00Z"), granularity: "hourly" });
    expect(result).toEqual({ expected: 0, succeeded: 0, failed: [], skipped: 0 });
    expect(opens).toBe(0);
  });

  it("rejects invalid lineage and incomplete explicit repository selections before opening GitHub", async () => {
    const [repositoryId] = await seedRepos(1);
    let opens = 0;
    const dependencies = {
      pool: runtimePool,
      sourceFactory: { openOperation() { opens += 1; throw new Error("must not open"); } },
      now: () => new Date("2026-07-19T12:40:00Z"),
    };
    await expect(refreshRepoMetrics(dependencies, {
      scheduledFor: new Date("2026-07-19T12:37:00Z"), granularity: "hourly", runId: "not-a-uuid",
    })).rejects.toMatchObject({ code: "validation_error" });
    await expect(refreshRepoMetrics(dependencies, {
      scheduledFor: new Date("2026-07-19T12:40:00Z"), granularity: "realtime",
      repositoryIds: [repositoryId, "00000000-0000-4000-8000-000000000001"],
    })).rejects.toMatchObject({ code: "validation_error" });
    expect(opens).toBe(0);
  });

  it("treats an invalid global response shape as systemic instead of hammering every repository", async () => {
    await seedRepos(2);
    const calls: string[] = [];
    const operation = metricOperation(calls, async (_name, _branch, at) => aux(at, 1));
    operation.getCoreMetrics = async (fullName) => {
      calls.push(`core:${fullName}`);
      throw new GitHubSourceError("response_invalid");
    };
    await expect(refreshRepoMetrics({
      pool: runtimePool, sourceFactory: factory(operation), now: () => new Date("2026-07-19T12:40:00Z"),
    }, { scheduledFor: new Date("2026-07-19T12:37:00Z"), granularity: "hourly" }))
      .rejects.toMatchObject({ code: "source_unavailable" });
    expect(calls).toEqual(["core:owner/r1"]);
    expect(operation.closeCalls).toBe(1);
  });

  it("performs all repository cores before aux and records unspent aux work as partial", async () => {
    const ids = await seedRepos(3);
    const calls: string[] = [];
    const operation = metricOperation(calls, async (fullName, _defaultBranch, capturedAt) => {
      if (fullName !== "owner/r1") throw new GitHubSourceError("request_budget_exceeded");
      return aux(capturedAt, 1);
    });
    const result = await refreshRepoMetrics({ pool: runtimePool, sourceFactory: factory(operation), now: () => new Date("2026-07-19T12:40:00Z") }, {
      scheduledFor: new Date("2026-07-19T12:37:00Z"), granularity: "hourly",
    });
    expect(calls.slice(0, 3)).toEqual(["core:owner/r1", "core:owner/r2", "core:owner/r3"]);
    expect(result).toEqual({ expected: 3, succeeded: 1, skipped: 0, failed: [
      { id: ids[1], code: "aux_budget_exhausted" }, { id: ids[2], code: "aux_budget_exhausted" },
    ] });
    const rows = await runtimePool.query("select repository_id,stars,aux_metrics_captured_at,collected_fields from ace_hunter.repository_snapshots order by repository_id");
    expect(rows.rowCount).toBe(3);
    expect(rows.rows.every((row) => row.stars === "101")).toBe(true);
    expect(rows.rows.filter((row) => row.aux_metrics_captured_at !== null)).toHaveLength(1);
    expect(operation.closeCalls).toBe(1);
  });

  it("reuses a scheduled UTC bucket and preserves the original aux capture time until due", async () => {
    const [repositoryId] = await seedRepos(1);
    const previousAuxAt = new Date("2026-07-19T07:00:00Z");
    await insertSnapshot(repositoryId, new Date("2026-07-19T07:00:00Z"), previousAuxAt, 55);
    const first = metricOperation([], async () => { throw new Error("aux must not run"); });
    await refreshRepoMetrics({ pool: runtimePool, sourceFactory: factory(first), now: () => new Date("2026-07-19T12:30:00Z") }, {
      scheduledFor: new Date("2026-07-19T12:59:59Z"), granularity: "hourly",
    });
    const retry = metricOperation([], async (_fullName, _defaultBranch, capturedAt) => aux(capturedAt, 9));
    await refreshRepoMetrics({ pool: runtimePool, sourceFactory: factory(retry), now: () => new Date("2026-07-19T12:31:00Z") }, {
      scheduledFor: new Date("2026-07-19T12:01:00Z"), granularity: "hourly",
    });
    const rows = await runtimePool.query("select captured_at,aux_metrics_captured_at,commits_30d from ace_hunter.repository_snapshots where captured_at='2026-07-19 12:00:00+00'");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].captured_at.toISOString()).toBe("2026-07-19T12:00:00.000Z");
    expect(rows.rows[0].aux_metrics_captured_at.toISOString()).toBe(previousAuxAt.toISOString());
    expect(rows.rows[0].commits_30d).toBe(55);
  });

  it("recomputes candidate-v2 provenance from current Core facts instead of copying v1 snapshots", async () => {
    const [eligibleId, ineligibleId] = await seedRepos(2);
    const priorAt = new Date("2026-07-19T07:00:00Z");
    for (const repositoryId of [eligibleId, ineligibleId]) {
      await new SnapshotStore(runtimePool).insert({
        repositoryId, capturedAt: priorAt, granularity: "hourly", stars: 1_000, forks: 1,
        commits30d: 55, prTotal: 8, prOpen: 2, prMerged: 3, releasesCount: 4,
        issuesTotal: 9, issuesOpen: 4, issuesClosed: 5, auxMetricsCapturedAt: priorAt,
        candidateBuckets: ["age_7d_stars_100", "age_30d_stars_1000"], candidateRuleVersion: "v1",
        collectedFields: { core: true, aux: true, observed_at: priorAt.toISOString() },
      });
    }
    const operation = metricOperation([], async (_name, _branch, at) => aux(at, 9));
    operation.getCoreMetrics = async (fullName, capturedAt) => ({
      stars: 101, forks: 7,
      metadata: { ...repo(fullName), createdAt: fullName === "owner/r1"
        ? new Date("2026-07-18T12:40:00Z") : new Date("2026-07-01T00:00:00Z") },
      capturedAt,
    });
    await refreshRepoMetrics({
      pool: runtimePool, sourceFactory: factory(operation), now: () => new Date("2026-07-19T12:40:00Z"),
    }, { scheduledFor: new Date("2026-07-19T12:37:00Z"), granularity: "hourly" });

    const rows = (await runtimePool.query(`select repository_id,candidate_buckets,candidate_rule_version
      from ace_hunter.repository_snapshots where captured_at='2026-07-19T12:00:00Z'
      order by repository_id`)).rows;
    expect(rows).toEqual([
      { repository_id: eligibleId, candidate_buckets: ["age_1d_stars_10", "age_3d_stars_100"], candidate_rule_version: "v2" },
      { repository_id: ineligibleId, candidate_buckets: [], candidate_rule_version: "v2" },
    ].sort((left, right) => left.repository_id.localeCompare(right.repository_id)));
  });

  it("uses actual realtime capture timestamps and isolates operations between jobs", async () => {
    await seedRepos(1);
    const first = metricOperation([], async (_name, _defaultBranch, at) => aux(at, 2));
    const second = metricOperation([], async (_name, _defaultBranch, at) => aux(at, 3));
    let opens = 0;
    const [repositoryId] = (await runtimePool.query<{ id: string }>("select id from ace_hunter.repositories")).rows.map((row) => row.id);
    await refreshRepoMetrics({ pool: runtimePool, sourceFactory: { openOperation: () => ++opens === 1 ? first : second }, now: () => new Date("2026-07-19T12:34:56.789Z") }, {
      scheduledFor: new Date("2026-07-19T12:34:56.789Z"), granularity: "realtime",
      repositoryIds: [repositoryId],
    });
    await refreshRepoMetrics({ pool: runtimePool, sourceFactory: { openOperation: () => ++opens === 2 ? second : first }, now: () => new Date("2026-07-19T12:35:01.123Z") }, {
      scheduledFor: new Date("2026-07-19T12:35:01.123Z"), granularity: "realtime",
      repositoryIds: [repositoryId],
    });
    expect(opens).toBe(2);
    expect((await runtimePool.query("select captured_at from ace_hunter.repository_snapshots order by captured_at")).rows.map((row) => row.captured_at.toISOString()))
      .toEqual(["2026-07-19T12:34:56.789Z", "2026-07-19T12:35:01.123Z"]);
  });

  it("never lets an older auxiliary upsert regress facts, evidence, or candidate provenance", async () => {
    const [repositoryId] = await seedRepos(1);
    const bucket = new Date("2026-07-19T12:00:00Z");
    await new SnapshotStore(runtimePool).insert({ repositoryId, capturedAt: bucket, granularity: "hourly", stars: 10, forks: 1,
      commits30d: 50, prTotal: 8, prOpen: 2, prMerged: 3, releasesCount: 4, issuesTotal: 9, issuesOpen: 4,
      issuesClosed: 5, auxMetricsCapturedAt: new Date("2026-07-19T12:50:00Z"), candidateBuckets: ["1d_10"],
      candidateRuleVersion: "v1", collectedFields: { core: true, aux: true, aux_reused: false,
        aux_window_end: "2026-07-19T12:50:00.000Z", capacity_status: "ok" } });
    await new SnapshotStore(runtimePool).insert({ repositoryId, capturedAt: bucket, granularity: "hourly", stars: 11, forks: 2,
      commits30d: 1, prTotal: 1, prOpen: 1, prMerged: 0, releasesCount: 1, issuesTotal: 1, issuesOpen: 1,
      issuesClosed: 0, auxMetricsCapturedAt: new Date("2026-07-19T12:40:00Z"), candidateBuckets: [],
      collectedFields: { core: true, aux: false, aux_reused: true, aux_window_end: "2026-07-19T12:40:00.000Z" } });
    expect((await runtimePool.query("select stars,commits_30d,aux_metrics_captured_at,candidate_buckets,candidate_rule_version,collected_fields from ace_hunter.repository_snapshots")).rows[0])
      .toEqual({ stars: "11", commits_30d: 50, aux_metrics_captured_at: new Date("2026-07-19T12:50:00Z"),
        candidate_buckets: ["1d_10"], candidate_rule_version: "v1", collected_fields: expect.objectContaining({
          aux: true, aux_reused: false, aux_window_end: "2026-07-19T12:50:00.000Z", capacity_status: "ok",
        }) });
  });

  it("never lets an older Core observation overwrite a newer response in the same bucket", async () => {
    const [repositoryId] = await seedRepos(1);
    const bucket = new Date("2026-07-19T12:00:00Z");
    const store = new SnapshotStore(runtimePool);
    const base = { repositoryId, capturedAt: bucket, granularity: "hourly" as const,
      commits30d: null, prTotal: null, prOpen: null, prMerged: null, releasesCount: null,
      issuesTotal: null, issuesOpen: null, issuesClosed: null };
    await store.insert({ ...base, stars: 20, forks: 4,
      candidateBuckets: ["age_1d_stars_10", "age_3d_stars_100"], candidateRuleVersion: "v2",
      collectedFields: { core: true, observed_at: "2026-07-19T12:50:00.000Z", source_job_run_id: "new" } });
    await store.insert({ ...base, stars: 10, forks: 2,
      candidateBuckets: [], candidateRuleVersion: "v1",
      collectedFields: { core: true, observed_at: "2026-07-19T12:40:00.000Z", source_job_run_id: "old" } });
    expect((await runtimePool.query(
      `select stars,forks,candidate_buckets,candidate_rule_version,collected_fields
       from ace_hunter.repository_snapshots where repository_id=$1`,
      [repositoryId],
    )).rows[0]).toEqual({ stars: "20", forks: "4",
      candidate_buckets: ["age_1d_stars_10", "age_3d_stars_100"], candidate_rule_version: "v2",
      collected_fields: expect.objectContaining({
      observed_at: "2026-07-19T12:50:00.000Z", source_job_run_id: "new",
    }) });
  });
});

function factory(operation: GitHubMetricSourceOperation) { return { openOperation: () => operation }; }

function metricOperation(calls: string[], getAux: GitHubMetricSourceOperation["getAuxMetrics"]): GitHubMetricSourceOperation & { closeCalls: number } {
  return {
    closeCalls: 0,
    async getMetricRateLimit() { return { coreRemaining: 5_000, graphqlRemaining: 5_000, resetAt: new Date("2026-07-20T00:00:00Z") }; },
    async getCoreMetrics(fullName, capturedAt): Promise<CoreMetrics> { calls.push(`core:${fullName}`); return { stars: 101, forks: 7, metadata: repo(fullName), capturedAt }; },
    async getAuxMetrics(fullName, defaultBranch, capturedAt): Promise<AuxMetrics> { calls.push(`aux:${fullName}:${defaultBranch}`); return getAux(fullName, defaultBranch, capturedAt); },
    close() { this.closeCalls += 1; },
    async getRateLimit() { return { remaining: 5_000, resetAt: new Date("2026-07-20T00:00:00Z") }; },
    async searchRepositories() { throw new Error("not used"); },
    async getRepository() { throw new Error("not used"); },
    async hasReadme() { throw new Error("not used"); },
  };
}

function aux(capturedAt: Date, commits30d: number): AuxMetrics {
  return { commits30d, prTotal: 8, prOpen: 2, prMerged: 3, releasesCount: 4,
    latestReleaseAt: new Date("2026-07-18T00:00:00Z"), latestReleaseTag: "v1",
    issuesTotal: 9, issuesOpen: 4, issuesClosed: 5, capturedAt };
}

function repo(fullName: string) {
  const name = fullName.split("/")[1];
  return { githubRepoId: Number(name.slice(1)), nodeId: `node-${name}`, ownerId: 1,
    ownerLogin: "owner", ownerType: "User" as const, ownerProfileUrl: "https://github.com/owner",
    ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4", name, fullName, description: "repo",
    repoUrl: `https://github.com/${fullName}`, homepageUrl: null, defaultBranch: "main", language: "TypeScript",
    license: "MIT", topics: [], hasReadme: true, createdAt: new Date("2026-07-01T00:00:00Z"), pushedAt: null,
    stars: 101, forks: 7, visibility: "public" as const, isPrivate: false as const, isFork: false,
    isArchived: false, isTemplate: false, isMirror: false };
}

async function seedRepos(count: number): Promise<string[]> {
  const result = await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
    (github_repo_id,github_node_id,owner_id,owner_login,owner_type,name,full_name,repo_url,default_branch,
     topics,has_readme,github_created_at,is_fork,is_archived,is_template,is_mirror,status)
    select n,'node-r'||n,1,'owner','User','r'||n,'owner/r'||n,'https://github.com/owner/r'||n,'main',
      '[]'::jsonb,true,'2026-07-01',false,false,false,false,'active'
    from generate_series(1,$1) n returning id`, [count]);
  return result.rows.map((row) => row.id);
}

async function insertSnapshot(repositoryId: string, capturedAt: Date, auxAt: Date, commits: number): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.repository_snapshots
    (repository_id,captured_at,granularity,stars,forks,commits_30d,pr_total,pr_open,pr_merged,releases_count,
     issues_total,issues_open,issues_closed,aux_metrics_captured_at,collected_fields)
    values($1,$2,'hourly',10,1,$3,8,2,3,4,9,4,5,$4,'{"core":true,"aux":true}'::jsonb)`,
  [repositoryId, capturedAt, commits, auxAt]);
}
