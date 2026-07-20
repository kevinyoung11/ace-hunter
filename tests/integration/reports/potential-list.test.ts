import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadPotentialRepositories } from "../../../src/reports/potential-list.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const now = new Date("2026-07-20T00:00:00.000Z");
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

describe("potential repository read model", () => {
  it("applies the exact candidate-v2 age and Star boundaries at the fixed cutoff", async () => {
    await seed("at-24h-10", "2026-07-19T00:00:00.000Z", 10);
    await seed("at-24h-9", "2026-07-19T00:00:00.000Z", 9);
    await seed("over-24h-100", "2026-07-18T23:59:59.999Z", 100);
    await seed("at-72h-100", "2026-07-17T00:00:00.000Z", 100);
    await seed("at-72h-99", "2026-07-17T00:00:00.000Z", 99);
    await seed("over-72h", "2026-07-16T23:59:59.999Z", 1000);
    await seed("dual", "2026-07-19T23:00:00.000Z", 100);
    await seed("future-created", "2026-07-20T00:00:00.001Z", 1000);

    const result = await loadPotentialRepositories(runtimePool, { now, rule: "all", limit: null });
    const byName = Object.fromEntries(result.items.map((item) => [item.name, item]));

    expect(Object.keys(byName).sort()).toEqual(["at-24h-10", "at-72h-100", "dual", "over-24h-100"].sort());
    expect(byName["at-24h-10"].matchedRules).toEqual(["1d"]);
    expect(byName["over-24h-100"].matchedRules).toEqual(["3d"]);
    expect(byName["at-72h-100"].matchedRules).toEqual(["3d"]);
    expect(byName.dual.matchedRules).toEqual(["1d", "3d"]);
  });

  it("reads only active primary non-fork non-archived non-mirror repositories", async () => {
    await seed("included", "2026-07-19T23:00:00.000Z", 10);
    await seed("fork", "2026-07-19T23:00:00.000Z", 100, { isFork: true });
    await seed("archived", "2026-07-19T23:00:00.000Z", 100, { isArchived: true });
    await seed("mirror", "2026-07-19T23:00:00.000Z", 100, { isMirror: true });
    await seed("inactive-repo", "2026-07-19T23:00:00.000Z", 100, { repositoryStatus: "inaccessible" });
    await seed("inactive-product", "2026-07-19T23:00:00.000Z", 100, { productStatus: "inactive" });
    await seed("secondary", "2026-07-19T23:00:00.000Z", 100, { primary: false });

    const result = await loadPotentialRepositories(runtimePool, { now, rule: "all", limit: null });

    expect(result.items.map((item) => item.name)).toEqual(["included"]);
  });

  it("uses the latest cutoff-safe snapshot and exposes repository metadata", async () => {
    const seeded = await seed("metadata", "2026-07-19T22:00:00.000Z", 10, {
      description: "Useful repository",
      homepageUrl: "https://metadata.example",
      forks: 4,
      capturedAt: "2026-07-19T23:40:00.000Z",
    });
    await addSnapshot(seeded.repositoryId, 20, "2026-07-19T23:50:00.000Z", "2026-07-19T23:50:00.000Z", 5);
    await addSnapshot(seeded.repositoryId, 999, "2026-07-20T00:00:00.001Z", "2026-07-20T00:00:00.001Z", 999);
    await addSnapshot(seeded.repositoryId, 888, "2026-07-19T23:55:00.000Z", "2026-07-20T00:00:00.001Z", 888);
    await runtimePool.query(`insert into ace_hunter.repository_snapshots
      (repository_id,captured_at,granularity,stars,forks,collected_fields,created_at)
      values($1,'2026-07-19T23:59:00Z','realtime',777,777,
        '{"observed_at":"2026-07-19T23:59:00.000Z"}','2026-07-20T00:00:00.001Z')`, [seeded.repositoryId]);

    const result = await loadPotentialRepositories(runtimePool, { now, rule: "all", limit: null });

    expect(result).toMatchObject({ kind: "potential_repositories", rule: "all", generatedAt: now.toISOString() });
    expect(result.items).toEqual([expect.objectContaining({
      repositoryId: seeded.repositoryId,
      name: "metadata",
      fullName: "owner/metadata",
      description: "Useful repository",
      owner: "owner",
      repositoryUrl: "https://github.com/owner/metadata",
      homepageUrl: "https://metadata.example/",
      createdAt: "2026-07-19T22:00:00.000Z",
      ageHours: 2,
      stars: 20,
      starsPerHour: 10,
      forks: 5,
      capturedAt: "2026-07-19T23:50:00.000Z",
      matchedRules: ["1d"],
    })]);
  });

  it("filters by rule, sorts deterministically and applies a per-request limit", async () => {
    await seed("dual", "2026-07-19T23:00:00.000Z", 100);
    await seed("z-tie", "2026-07-19T22:00:00.000Z", 20);
    await seed("a-tie", "2026-07-19T22:00:00.000Z", 20);
    await seed("three-day", "2026-07-18T00:00:00.000Z", 100);

    expect((await loadPotentialRepositories(runtimePool, { now, rule: "all", limit: 3 })).items
      .map((item) => item.fullName)).toEqual(["owner/dual", "owner/a-tie", "owner/z-tie"]);
    expect((await loadPotentialRepositories(runtimePool, { now, rule: "1d", limit: null })).items
      .map((item) => item.name)).toEqual(["dual", "a-tie", "z-tie"]);
    expect((await loadPotentialRepositories(runtimePool, { now, rule: "3d", limit: null })).items
      .map((item) => item.name)).toEqual(["dual", "three-day"]);
  });

  it("uses every documented comparator level after velocity ties", async () => {
    await seed("stars-high", "2026-07-19T22:00:00.000Z", 20);
    await seed("created-new-z", "2026-07-19T23:45:00.000Z", 10);
    await seed("created-new-a", "2026-07-19T23:45:00.000Z", 10);
    await seed("created-middle", "2026-07-19T23:30:00.000Z", 10);
    await seed("stars-low", "2026-07-19T23:00:00.000Z", 10);

    const result = await loadPotentialRepositories(runtimePool, { now, rule: "all", limit: null });

    expect(result.items.map((item) => [item.name, item.starsPerHour])).toEqual([
      ["stars-high", 10],
      ["created-new-a", 10],
      ["created-new-z", 10],
      ["created-middle", 10],
      ["stars-low", 10],
    ]);
  });

  it("rejects invalid options and unsafe numeric facts", async () => {
    await expect(loadPotentialRepositories(runtimePool, { now: new Date("bad"), rule: "all", limit: 20 }))
      .rejects.toThrow("invalid_potential_now");
    await expect(loadPotentialRepositories(runtimePool, { now, rule: "bad" as "all", limit: 20 }))
      .rejects.toThrow("invalid_potential_rule");
    for (const limit of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(loadPotentialRepositories(runtimePool, { now, rule: "all", limit }))
        .rejects.toThrow("invalid_potential_limit");
    }

    const seeded = await seed("unsafe", "2026-07-19T23:00:00.000Z", 10);
    await runtimePool.query(`update ace_hunter.repository_snapshots
      set stars=9007199254740992 where repository_id=$1`, [seeded.repositoryId]);
    await expect(loadPotentialRepositories(runtimePool, { now, rule: "all", limit: null }))
      .rejects.toThrow("unsafe_potential_numeric_value:stars");
  });
});

type SeedOptions = {
  isFork?: boolean;
  isArchived?: boolean;
  isMirror?: boolean;
  repositoryStatus?: "active" | "inaccessible";
  productStatus?: "active" | "inactive";
  primary?: boolean;
  description?: string;
  homepageUrl?: string;
  forks?: number;
  capturedAt?: string;
};

async function seed(name: string, createdAt: string, stars: number, options: SeedOptions = {}) {
  const repositoryId = (await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
    (github_repo_id,owner_login,name,full_name,description,repo_url,homepage_url,github_created_at,
      is_fork,is_archived,is_template,is_mirror,status)
    values($1,'owner',$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11) returning id`, [
    nextGitHubId++, name, `owner/${name}`, options.description ?? null,
    `https://github.com/owner/${name}`, options.homepageUrl ?? null, createdAt,
    options.isFork ?? false, options.isArchived ?? false, options.isMirror ?? false,
    options.repositoryStatus ?? "active",
  ])).rows[0].id;
  const productId = (await runtimePool.query<{ id: string }>(
    "insert into ace_hunter.products(name,status) values($1,$2) returning id",
    [name, options.productStatus ?? "active"],
  )).rows[0].id;
  await runtimePool.query(`insert into ace_hunter.product_repositories
    (product_id,repository_id,role,is_primary,link_source) values($1,$2,$3,$4,'github')`,
  [productId, repositoryId, options.primary === false ? "secondary" : "primary", options.primary !== false]);
  await addSnapshot(
    repositoryId,
    stars,
    options.capturedAt ?? "2026-07-19T23:30:00.000Z",
    options.capturedAt ?? "2026-07-19T23:30:00.000Z",
    options.forks ?? 0,
  );
  return { productId, repositoryId };
}

async function addSnapshot(repositoryId: string, stars: number, capturedAt: string, observedAt: string, forks: number) {
  await runtimePool.query(`insert into ace_hunter.repository_snapshots
    (repository_id,captured_at,granularity,stars,forks,collected_fields,created_at)
    values($1,$2,'hourly',$3,$4,jsonb_build_object('observed_at',$5::text),$2)`,
  [repositoryId, capturedAt, stars, forks, new Date(observedAt).toISOString()]);
}
