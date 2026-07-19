import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { SnapshotStore } from "../../../src/db/stores/snapshot-store.js";
import { collectGithubTrending } from "../../../src/jobs/collect-github-trending.js";
import { JobRunner } from "../../../src/jobs/job-runner.js";
import { createProductFromRepo } from "../../../src/products/create-product-from-repo.js";
import type { GitHubRepository, GitHubSourceOperation } from "../../../src/sources/github/github-source.js";
import { GitHubSourceError } from "../../../src/sources/github/github-source.js";
import type { TrendingCollection, TrendingEntry, TrendingPeriod, TrendingSource } from "../../../src/sources/trending/trending-source.js";
import { TrendingSourceError } from "../../../src/sources/trending/trending-source.js";
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
  lockPool = new Pool({ connectionString: config.runtimeDatabaseUrl });
});

beforeEach(async () => {
  await adminPool.query(`truncate ace_hunter.analysis_outputs,ace_hunter.product_x_posts,
    ace_hunter.github_trending_snapshots,ace_hunter.user_product_monitors,
    ace_hunter.repository_snapshots,ace_hunter.product_repositories,
    ace_hunter.job_runs,ace_hunter.repositories,ace_hunter.products cascade`);
});

afterAll(async () => await Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end(), lockPool.end()]));

describe("collectGithubTrending", () => {
  it("persists all periods, creates separate products, and idempotently replaces one scheduled bucket", async () => {
    const scheduledFor = new Date("2026-07-19T04:37:00Z");
    const source = fakeGithub([repo(1, "one/a"), repo(2, "two/b"), repo(3, "three/c")]);
    for (const [index, period] of (["daily", "weekly", "monthly"] as const).entries()) {
      const entry = { rank: 1, fullName: ["one/a", "two/b", "three/c"][index], starsInPeriod: 10 + index };
      expect(await collectGithubTrending(dependencies(source, [entry]), { period, scheduledFor })).toMatchObject({ expected: 1, succeeded: 1, failed: [] });
    }
    expect((await runtimePool.query("select distinct period from ace_hunter.github_trending_snapshots order by period")).rows.map((row) => row.period))
      .toEqual(["daily", "monthly", "weekly"]);
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.products")).rows[0].n).toBe(3);
    expect((await runtimePool.query("select distinct captured_at from ace_hunter.github_trending_snapshots")).rows[0].captured_at.toISOString())
      .toBe("2026-07-19T04:00:00.000Z");

    const replacement = { rank: 1, fullName: "one/a", starsInPeriod: 99 };
    await collectGithubTrending(dependencies(source, [replacement]), { period: "daily", scheduledFor });
    const daily = await runtimePool.query("select rank,stars_in_period,collection_status from ace_hunter.github_trending_snapshots where period='daily'");
    expect(daily.rows).toEqual([{ rank: 1, stars_in_period: "99", collection_status: "success" }]);
  });

  it("preflights once, preserves rank gaps, and stores successful rows as partial for item-level missing repos", async () => {
    const source = fakeGithub([repo(1, "one/a"), repo(3, "three/c")]);
    source.getRepository = async (fullName) => {
      if (fullName === "missing/b") throw new GitHubSourceError("not_found");
      return [repo(1, "one/a"), repo(3, "three/c")].find((item) => item.fullName === fullName)!;
    };
    const entries = [
      { rank: 1, fullName: "one/a", starsInPeriod: 30 },
      { rank: 2, fullName: "missing/b", starsInPeriod: 20 },
      { rank: 3, fullName: "three/c", starsInPeriod: 10 },
    ];
    const result = await collectGithubTrending(dependencies(source, entries), { period: "daily", scheduledFor: new Date("2026-07-19T08:00:00Z") });
    expect(result).toEqual({ expected: 3, succeeded: 2, failed: [{ id: "missing/b", code: "not_found" }], skipped: 0 });
    expect(source.preflightCalls).toBe(1);
    expect((await runtimePool.query("select rank,collection_status from ace_hunter.github_trending_snapshots order by rank")).rows)
      .toEqual([{ rank: 1, collection_status: "partial" }, { rank: 3, collection_status: "partial" }]);
  });

  it("writes a new repo core snapshot in the product transaction and never overwrites an existing repo snapshot", async () => {
    const scheduledFor = new Date("2026-07-19T08:42:00Z");
    const newRepository = repo(1, "one/a");
    await collectGithubTrending(dependencies(fakeGithub([newRepository]), [{ rank: 1, fullName: "one/a", starsInPeriod: 5 }]), { period: "daily", scheduledFor });
    const first = (await runtimePool.query("select stars,forks,candidate_buckets,collected_fields from ace_hunter.repository_snapshots")).rows[0];
    expect(first).toEqual({
      stars: "100", forks: "2", candidate_buckets: [],
      collected_fields: expect.objectContaining({ core: true, source: "github_trending", capacity_status: "ok", tracked_count: 1 }),
    });

    const existingRepository = repo(2, "two/b");
    const existing = await createProductFromRepo(runtimePool, existingRepository);
    await new SnapshotStore(runtimePool).insert({
      repositoryId: existing.repositoryId, capturedAt: new Date("2026-07-19T08:00:00Z"), granularity: "hourly",
      stars: 7, forks: 1, commits30d: null, prTotal: null, prOpen: null, prMerged: null,
      releasesCount: null, issuesTotal: null, issuesOpen: null, issuesClosed: null, candidateBuckets: [],
      collectedFields: { core: true, source: "github_discovery" },
    });
    await collectGithubTrending(dependencies(fakeGithub([{ ...existingRepository, stars: 999 }]), [{ rank: 1, fullName: "two/b", starsInPeriod: 4 }]), { period: "weekly", scheduledFor });
    expect((await runtimePool.query("select stars,collected_fields from ace_hunter.repository_snapshots where repository_id=$1", [existing.repositoryId])).rows[0])
      .toEqual({ stars: "7", collected_fields: { core: true, source: "github_discovery" } });
  });

  it("does not overwrite a snapshot for an existing unlinked repository", async () => {
    const existingRepository = repo(4, "orphan/repo");
    const inserted = await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
      (github_repo_id,github_node_id,owner_id,owner_login,owner_type,owner_profile_url,owner_avatar_url,
       name,full_name,description,repo_url,default_branch,topics,has_readme,github_created_at,
       is_fork,is_archived,is_template,is_mirror,status)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'[]'::jsonb,true,$13,false,false,false,false,'active') returning id`,
    [existingRepository.githubRepoId, existingRepository.nodeId, existingRepository.ownerId, existingRepository.ownerLogin,
      existingRepository.ownerType, existingRepository.ownerProfileUrl, existingRepository.ownerAvatarUrl, existingRepository.name,
      existingRepository.fullName, existingRepository.description, existingRepository.repoUrl, existingRepository.defaultBranch,
      existingRepository.createdAt]);
    await new SnapshotStore(runtimePool).insert({
      repositoryId: inserted.rows[0].id, capturedAt: new Date("2026-07-19T08:00:00Z"), granularity: "hourly",
      stars: 8, forks: 1, commits30d: null, prTotal: null, prOpen: null, prMerged: null, releasesCount: null,
      issuesTotal: null, issuesOpen: null, issuesClosed: null, candidateBuckets: [], collectedFields: { source: "prior" },
    });
    await collectGithubTrending(dependencies(fakeGithub([{ ...existingRepository, stars: 999 }]), [{ rank: 1, fullName: "orphan/repo", starsInPeriod: 3 }]), {
      period: "daily", scheduledFor: new Date("2026-07-19T08:55:00Z"),
    });
    expect((await runtimePool.query("select stars,collected_fields from ace_hunter.repository_snapshots where repository_id=$1", [inserted.rows[0].id])).rows[0])
      .toEqual({ stars: "8", collected_fields: { source: "prior" } });
  });

  it("deduplicates final GitHub ids and does not replace a prior batch when every item fails", async () => {
    const scheduledFor = new Date("2026-07-19T12:00:00Z");
    const canonical = repo(1, "one/a");
    const alias = { ...canonical, fullName: "alias/a", repoUrl: "https://github.com/alias/a", ownerLogin: "alias", ownerProfileUrl: "https://github.com/alias" };
    const duplicateResult = await collectGithubTrending(dependencies(fakeGithub([canonical, alias]), [
      { rank: 1, fullName: "one/a", starsInPeriod: 5 }, { rank: 2, fullName: "alias/a", starsInPeriod: 4 },
    ]), { period: "daily", scheduledFor });
    expect(duplicateResult).toMatchObject({ succeeded: 1, failed: [{ id: "alias/a", code: "duplicate" }] });
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.github_trending_snapshots")).rows[0].n).toBe(1);

    const missing = fakeGithub([]);
    missing.getRepository = async () => { throw new GitHubSourceError("not_found"); };
    const failed = await collectGithubTrending(dependencies(missing, [{ rank: 1, fullName: "gone/repo", starsInPeriod: 1 }]), { period: "daily", scheduledFor });
    expect(failed).toMatchObject({ succeeded: 0, failed: [{ id: "gone/repo", code: "not_found" }] });
    expect((await runtimePool.query("select rank from ace_hunter.github_trending_snapshots")).rows).toEqual([{ rank: 1 }]);
  });

  it("treats capacity gates as systemic and writes no ranking batch", async () => {
    await seedRepositories(1_000);
    await expect(collectGithubTrending(dependencies(fakeGithub([repo(20_001, "new/repo")]), [{ rank: 1, fullName: "new/repo", starsInPeriod: 1 }]), {
      period: "daily", scheduledFor: new Date("2026-07-19T00:00:00Z"), reviewedCapacityOverride: true,
      capacityReviewId: "review", runId: "123e4567-e89b-42d3-a456-426614174000",
    })).rejects.toMatchObject({ code: "capacity_hard_limit", retryable: false });
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.github_trending_snapshots")).rows[0].n).toBe(0);
  });

  it("does not write a ranking batch for parser, preflight, enrichment, or close systemic errors", async () => {
    const options = { period: "daily" as const, scheduledFor: new Date("2026-07-19T08:00:00Z") };
    const parserFailure: TrendingSource = { collect: async () => { throw new TrendingSourceError("trending_structure_invalid"); } };
    await expect(collectGithubTrending({ pool: runtimePool, trendingSource: parserFailure, sourceFactory: { openOperation: async () => { throw new Error("must not open"); } } }, options))
      .rejects.toMatchObject({ code: "validation_error", retryable: false });

    for (const stage of ["preflight", "enrichment", "close"] as const) {
      const source = fakeGithub([repo(1, "one/a")]);
      if (stage === "preflight") source.getRateLimit = async () => { throw new GitHubSourceError("authentication_error"); };
      if (stage === "enrichment") source.getRepository = async () => { throw new GitHubSourceError("network_error"); };
      if (stage === "close") source.close = () => { throw new Error("close details"); };
      await expect(collectGithubTrending(dependencies(source, [{ rank: 1, fullName: "one/a", starsInPeriod: 1 }]), options))
        .rejects.toMatchObject(stage === "preflight" ? { code: "authentication_error", retryable: false } :
          stage === "enrichment" ? { code: "network_error", retryable: true } : { code: "source_unavailable", retryable: true });
      expect((await runtimePool.query("select count(*)::int n from ace_hunter.github_trending_snapshots")).rows[0].n).toBe(0);
    }
  });

  it("rejects malformed adapter output before opening a GitHub operation", async () => {
    let opened = false;
    const deps = dependencies(fakeGithub([]), [
      { rank: 1, fullName: "one/a", starsInPeriod: 1 },
      { rank: 1, fullName: "two/b", starsInPeriod: 2 },
    ]);
    deps.sourceFactory = { openOperation: async () => { opened = true; return fakeGithub([]); } };
    await expect(collectGithubTrending(deps, { period: "daily", scheduledFor: new Date("2026-07-19T00:00:00Z") }))
      .rejects.toMatchObject({ code: "validation_error", retryable: false });
    expect(opened).toBe(false);
    await expect(collectGithubTrending(deps, { period: "daily", language: "typescript", scheduledFor: new Date("2026-07-19T00:00:00Z") }))
      .rejects.toMatchObject({ code: "validation_error", retryable: false });
  });

  it("rejects a malformed job run id before fetching external data", async () => {
    let collected = false;
    await expect(collectGithubTrending({
      pool: runtimePool, sourceFactory: { openOperation: async () => fakeGithub([repo(1, "one/a")]) },
      trendingSource: { collect: async () => { collected = true; throw new Error("must not collect"); } },
    }, {
      period: "daily", scheduledFor: new Date("2026-07-19T00:00:00Z"), runId: "not-a-uuid",
    })).rejects.toMatchObject({ code: "validation_error", retryable: false });
    expect(collected).toBe(false);
  });

  it("runs through the durable JobRunner idempotently and records parser failure without side effects", async () => {
    const runner = new JobRunner(runtimePool, { lockPool, loadedSecrets: [] });
    const scheduledFor = new Date("2026-07-19T16:00:00Z");
    const deps = dependencies(fakeGithub([repo(1, "one/a")]), [{ rank: 1, fullName: "one/a", starsInPeriod: 8 }]);
    const input = { name: "collect_github_trending", triggerType: "schedule" as const, scheduledFor, parameters: { period: "daily" } };
    const handler = async (context: { runId: string; scheduledFor: Date }) => collectGithubTrending(deps, {
      period: "daily", runId: context.runId, scheduledFor: context.scheduledFor,
    });
    expect(await runner.run(input, handler)).toMatchObject({ executed: true, status: "success" });
    expect(await runner.run(input, handler)).toMatchObject({ executed: false, status: "success" });
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.job_runs")).rows[0].n).toBe(1);
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.github_trending_snapshots")).rows[0].n).toBe(1);

    let opened = false;
    const broken = {
      pool: runtimePool,
      trendingSource: { collect: async () => { throw new TrendingSourceError("trending_structure_invalid"); } },
      sourceFactory: { openOperation: async () => { opened = true; return fakeGithub([]); } },
    };
    await expect(runner.run({ ...input, scheduledFor: new Date("2026-07-19T20:00:00Z") }, async (context) => collectGithubTrending(broken, {
      period: "daily", runId: context.runId, scheduledFor: context.scheduledFor,
    }))).rejects.toThrow(/job failed/);
    expect(opened).toBe(false);
    expect((await runtimePool.query("select status from ace_hunter.job_runs order by scheduled_for")).rows.map((row) => row.status))
      .toEqual(["success", "failed"]);
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.products")).rows[0].n).toBe(1);
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.github_trending_snapshots")).rows[0].n).toBe(1);
  });
});

async function seedRepositories(count: number): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.repositories
    (github_repo_id,owner_login,owner_type,name,full_name,repo_url,default_branch,topics,has_readme,github_created_at,is_fork,is_archived,is_template,is_mirror,status)
    select n,'seed','User','r'||n,'seed/r'||n,'https://github.com/seed/r'||n,'main','[]'::jsonb,true,now(),false,false,false,false,'active'
    from generate_series(1,$1::int) n`, [count]);
}

function dependencies(source: FakeGithubSource, entries: TrendingEntry[]) {
  return {
    pool: runtimePool,
    sourceFactory: { openOperation: async () => source },
    trendingSource: new FakeTrendingSource(entries),
  };
}

class FakeTrendingSource implements TrendingSource {
  public constructor(private readonly entries: TrendingEntry[]) {}
  public async collect(period: TrendingPeriod): Promise<TrendingCollection> {
    return { entries: this.entries, sourceUrl: `https://github.com/trending?since=${period}` };
  }
}

interface FakeGithubSource extends GitHubSourceOperation { preflightCalls: number }

function fakeGithub(repositories: GitHubRepository[]): FakeGithubSource {
  const source: FakeGithubSource = {
    preflightCalls: 0,
    getRateLimit: async () => { source.preflightCalls += 1; return { remaining: 100, resetAt: new Date("2026-07-20T00:00:00Z") }; },
    searchRepositories: async () => ({ totalCount: 0, repositories: [], hasNextPage: false, nextPage: null }),
    getRepository: async (fullName) => repositories.find((item) => item.fullName === fullName)!,
    hasReadme: async () => true,
    close: () => undefined,
  };
  return source;
}

function repo(id: number, fullName: string): GitHubRepository {
  const [ownerLogin, name] = fullName.split("/");
  return {
    githubRepoId: id, nodeId: `R_${id}`, ownerId: id + 100, ownerLogin, ownerType: "User",
    ownerProfileUrl: `https://github.com/${ownerLogin}`, ownerAvatarUrl: `https://avatars.githubusercontent.com/u/${id + 100}`,
    name, fullName, description: "description", repoUrl: `https://github.com/${fullName}`, homepageUrl: null,
    defaultBranch: "main", language: "TypeScript", license: "MIT", topics: [], hasReadme: true,
    createdAt: new Date("2026-07-18T00:00:00Z"), pushedAt: new Date("2026-07-19T00:00:00Z"), stars: 100, forks: 2,
    visibility: "public", isPrivate: false, isFork: false, isArchived: false, isTemplate: false, isMirror: false,
  };
}
