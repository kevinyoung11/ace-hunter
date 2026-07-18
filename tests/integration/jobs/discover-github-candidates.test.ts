import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createProductFromRepo } from "../../../src/products/create-product-from-repo.js";
import { discoverGithubCandidates } from "../../../src/jobs/discover-github-candidates.js";
import type { GitHubRepository, GitHubSource } from "../../../src/sources/github/github-source.js";
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

describe("createProductFromRepo", () => {
  it("serializes the same repo and never merges different repos from one owner", async () => {
    const one = githubRepo({ githubRepoId: 101, name: "one", fullName: "same/one" });
    const two = githubRepo({ githubRepoId: 102, name: "two", fullName: "same/two" });
    await Promise.all([createInTransaction(one), createInTransaction(one)]);
    await createInTransaction(two);
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.repositories")).rows[0].n).toBe(2);
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.products")).rows[0].n).toBe(2);
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.product_repositories where is_primary")).rows[0].n).toBe(2);
  });

  it("warns from new count 800 and enforces reviewed 950 / hard 1000 boundaries", async () => {
    await seedRepositories(799);
    expect(await createInTransaction(githubRepo({ githubRepoId: 80_000 }))).toMatchObject({ capacity: "warning" });
    await seedRepositories(950);
    await expect(createInTransaction(githubRepo({ githubRepoId: 95_001 }))).rejects.toThrow(/capacity_review_required/);
    await expect(createInTransaction(githubRepo({ githubRepoId: 95_002 }), { reviewedCapacityOverride: true })).rejects.toThrow(/capacity_review_id_required/);
    expect(await createInTransaction(githubRepo({ githubRepoId: 95_003 }), { reviewedCapacityOverride: true, capacityReviewId: "review-2026-07" })).toMatchObject({ capacity: "reviewed" });
    await seedRepositories(1_000);
    await expect(createInTransaction(githubRepo({ githubRepoId: 100_001 }), { reviewedCapacityOverride: true, capacityReviewId: "review" })).rejects.toThrow(/capacity_hard_limit/);
  });

  it("lets only one different repo pass concurrently at count 999", async () => {
    await seedRepositories(999);
    const settled = await Promise.allSettled([
      createInTransaction(githubRepo({ githubRepoId: 200_001 }), { reviewedCapacityOverride: true, capacityReviewId: "review" }),
      createInTransaction(githubRepo({ githubRepoId: 200_002 }), { reviewedCapacityOverride: true, capacityReviewId: "review" }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await runtimePool.query("select count(*)::int n from ace_hunter.repositories where status='active'")).rows[0].n).toBe(1_000);
  });

  it("refreshes and repairs an existing repo link even at the hard limit", async () => {
    await seedRepositories(1_000);
    const stored = (await runtimePool.query<{ github_repo_id: string }>("select github_repo_id from ace_hunter.repositories order by github_repo_id limit 1")).rows[0];
    const result = await createInTransaction(githubRepo({ githubRepoId: Number(stored.github_repo_id), description: "refreshed" }));
    expect(result.productId).toMatch(/[0-9a-f-]{36}/);
    expect((await runtimePool.query("select description from ace_hunter.repositories where github_repo_id=$1", [stored.github_repo_id])).rows[0].description).toBe("refreshed");
  });
});

it("runs all rules, refreshes facts, excludes ineligible repos, and writes one idempotent hourly snapshot", async () => {
  const candidates = [
    githubRepo({ githubRepoId: 1, stars: 1_100, createdAt: new Date("2026-07-18T12:00:00Z") }),
    githubRepo({ githubRepoId: 2, description: "  ", hasReadme: false }),
    githubRepo({ githubRepoId: 3, isFork: true }),
    githubRepo({ githubRepoId: 4, isTemplate: true }),
  ];
  const source = fakeSource(candidates);
  const at = new Date("2026-07-19T00:34:00Z");
  const first = await discoverGithubCandidates({ pool: runtimePool, source }, at, { runId: "123e4567-e89b-42d3-a456-426614174000" });
  const second = await discoverGithubCandidates({ pool: runtimePool, source }, at, { runId: "123e4567-e89b-42d3-a456-426614174000" });
  expect(first).toMatchObject({ expected: 4, succeeded: 2, skipped: 2, failed: [] });
  expect(second).toMatchObject({ succeeded: 2 });
  expect((await runtimePool.query("select count(*)::int n from ace_hunter.repositories")).rows[0].n).toBe(2);
  const snapshot = (await runtimePool.query("select captured_at,candidate_buckets,candidate_rule_version,collected_fields from ace_hunter.repository_snapshots rs join ace_hunter.repositories r on r.id=rs.repository_id where r.github_repo_id=1")).rows[0];
  expect(snapshot.captured_at.toISOString()).toBe("2026-07-19T00:00:00.000Z");
  expect(snapshot.candidate_buckets).toEqual(["age_1d_stars_10", "age_7d_stars_100", "age_30d_stars_1000"]);
  expect(snapshot.candidate_rule_version).toBe("v1");
  expect(snapshot.collected_fields).toMatchObject({ core: true, source_job_run_id: "123e4567-e89b-42d3-a456-426614174000" });
});

it("normalizes an actual invocation time to GitHub's whole-second search precision", async () => {
  const repository = githubRepo({ githubRepoId: 50 });
  const result = await discoverGithubCandidates({ pool: runtimePool, source: fakeSource([repository]) }, new Date("2026-07-19T00:34:00.123Z"));
  expect(result.succeeded).toBe(1);
});

async function createInTransaction(repo: GitHubRepository, options = {}) {
  const client = await runtimePool.connect();
  try {
    await client.query("begin");
    const result = await createProductFromRepo(client, repo, options);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

async function seedRepositories(count: number): Promise<void> {
  await adminPool.query("truncate ace_hunter.repository_snapshots,ace_hunter.product_repositories,ace_hunter.repositories,ace_hunter.products cascade");
  await runtimePool.query(`insert into ace_hunter.repositories
    (github_repo_id,owner_login,owner_type,name,full_name,repo_url,default_branch,topics,has_readme,github_created_at,is_fork,is_archived,is_template,is_mirror,status)
    select n,'seed','User','r'||n,'seed/r'||n,'https://github.com/seed/r'||n,'main','[]'::jsonb,true,now(),false,false,false,false,'active'
    from generate_series(1,$1::int) n`, [count]);
}

function fakeSource(repositories: GitHubRepository[]): GitHubSource {
  return {
    getRateLimit: async () => ({ remaining: 30, resetAt: new Date("2026-07-20T00:00:00Z") }),
    searchRepositories: async (slice, page) => ({
      totalCount: page === 1 ? repositories.filter((repo) => repo.createdAt >= slice.from && repo.createdAt <= slice.to && repo.stars >= slice.minStars).length : 0,
      repositories: page === 1 ? repositories.filter((repo) => repo.createdAt >= slice.from && repo.createdAt <= slice.to && repo.stars >= slice.minStars) : [],
      hasNextPage: false, nextPage: null,
    }),
    getRepository: async (fullName) => repositories.find((repo) => repo.fullName === fullName)!,
    hasReadme: async (fullName) => repositories.find((repo) => repo.fullName === fullName)!.hasReadme,
  };
}

function githubRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  const id = overrides.githubRepoId ?? 10;
  return {
    githubRepoId: id, nodeId: `R_${id}`, ownerId: 9, ownerLogin: "same", ownerType: "User",
    ownerProfileUrl: "https://github.com/same", ownerAvatarUrl: "https://avatars.githubusercontent.com/u/9",
    name: "repo", fullName: `same/repo-${id}`, description: "description", repoUrl: `https://github.com/same/repo-${id}`,
    homepageUrl: "https://example.com/", defaultBranch: "main", language: "TypeScript", license: "MIT", topics: ["ai"], hasReadme: true,
    createdAt: new Date("2026-07-18T12:00:00Z"), pushedAt: new Date("2026-07-19T00:00:00Z"), stars: 110, forks: 2,
    visibility: "public", isPrivate: false, isFork: false, isArchived: false, isTemplate: false, isMirror: false,
    ...overrides,
  };
}
