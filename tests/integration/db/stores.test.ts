import { afterAll, beforeEach, expect, it } from "vitest";
import { Pool } from "pg";
import { AnalysisOutputStore } from "../../../src/db/stores/analysis-output-store.js";
import { JobRunStore } from "../../../src/db/stores/job-run-store.js";
import { MonitorStore } from "../../../src/db/stores/monitor-store.js";
import { ProductStore } from "../../../src/db/stores/product-store.js";
import { RepositoryStore } from "../../../src/db/stores/repository-store.js";
import { SnapshotStore } from "../../../src/db/stores/snapshot-store.js";
import { TrendingStore } from "../../../src/db/stores/trending-store.js";
import { XPostStore } from "../../../src/db/stores/x-post-store.js";

const adminPool = new Pool({ connectionString: process.env.ACE_TEST_ADMIN_DATABASE_URL });
const runtimePool = new Pool({ connectionString: process.env.ACE_TEST_RUNTIME_DATABASE_URL });

beforeEach(async () => {
  await adminPool.query(
    `truncate ace_hunter.analysis_outputs,ace_hunter.product_x_posts,
      ace_hunter.github_trending_snapshots,ace_hunter.user_product_monitors,
      ace_hunter.repository_snapshots,ace_hunter.product_repositories,
      ace_hunter.job_runs,ace_hunter.repositories,ace_hunter.products cascade`,
  );
  await adminPool.query("delete from auth.users");
});

afterAll(async () => {
  await Promise.all([adminPool.end(), runtimePool.end()]);
});

const repositoryInput = {
  githubRepoId: 101,
  githubNodeId: "R_101",
  ownerId: 201,
  ownerLogin: "ace",
  ownerType: "User",
  ownerProfileUrl: "https://github.com/ace",
  ownerAvatarUrl: "https://avatars.example/ace",
  name: "hunter",
  fullName: "ace/hunter",
  description: "first",
  repoUrl: "https://github.com/ace/hunter",
  homepageUrl: "https://example.test",
  defaultBranch: "main",
  language: "TypeScript",
  license: "MIT",
  topics: ["discovery"],
  hasReadme: true,
  githubCreatedAt: new Date("2026-07-01T00:00:00Z"),
  githubPushedAt: new Date("2026-07-19T00:00:00Z"),
  isFork: false,
  isArchived: false,
  isTemplate: false,
  isMirror: false,
};

it("upserts one repository and preserves zero versus unavailable snapshot metrics", async () => {
  const repositories = new RepositoryStore(runtimePool);
  const snapshots = new SnapshotStore(runtimePool);
  const firstId = await repositories.upsert(repositoryInput);
  const secondId = await repositories.upsert({ ...repositoryInput, description: "updated" });

  expect(secondId).toBe(firstId);
  expect(
    (await runtimePool.query("select count(*)::int count from ace_hunter.repositories"))
      .rows[0].count,
  ).toBe(1);
  expect(
    (await runtimePool.query("select description from ace_hunter.repositories where id=$1", [firstId]))
      .rows[0].description,
  ).toBe("updated");

  const zero = await snapshots.insert({
    repositoryId: firstId,
    capturedAt: new Date("2026-07-19T00:00:00Z"),
    granularity: "daily",
    stars: 10,
    forks: 0,
    commits30d: 0,
    prTotal: 0,
    prOpen: 0,
    prMerged: 0,
    releasesCount: 0,
    issuesTotal: 0,
    issuesOpen: 0,
    issuesClosed: 0,
    candidateBuckets: ["age_30d_stars_1000"],
    collectedFields: { auxiliary: true },
  });
  const unavailable = await snapshots.insert({
    repositoryId: firstId,
    capturedAt: new Date("2026-07-20T00:00:00Z"),
    granularity: "daily",
    stars: 11,
    forks: null,
    commits30d: null,
    prTotal: null,
    prOpen: null,
    prMerged: null,
    releasesCount: null,
    issuesTotal: null,
    issuesOpen: null,
    issuesClosed: null,
    candidateBuckets: [],
    collectedFields: { auxiliary: false },
  });

  expect(zero).toMatchObject({ forks: 0, commits30d: 0, issuesTotal: 0 });
  expect(unavailable).toMatchObject({ forks: null, commits30d: null, issuesTotal: null });
});

it("persists each approved aggregate through parameterized stores", async () => {
  const repositories = new RepositoryStore(runtimePool);
  const products = new ProductStore(runtimePool);
  const jobs = new JobRunStore(runtimePool);
  const trending = new TrendingStore(runtimePool);
  const posts = new XPostStore(runtimePool);
  const monitors = new MonitorStore(runtimePool);
  const analyses = new AnalysisOutputStore(runtimePool);

  const repositoryId = await repositories.upsert(repositoryInput);
  const productId = await products.create({
    name: "Ace Hunter",
    description: "Discovery",
    websiteUrl: "https://example.test",
    identifiers: { github: "ace/hunter" },
  });
  await products.linkRepository({
    productId,
    repositoryId,
    role: "primary",
    isPrimary: true,
    confidence: 1,
    linkSource: "discovery",
  });
  const jobRunId = await jobs.create({
    jobName: "collect_trending",
    triggerType: "schedule",
    scheduledFor: new Date("2026-07-19T00:00:00Z"),
    status: "running",
    startedAt: new Date("2026-07-19T00:00:00Z"),
    idempotencyKey: "job-1",
  });
  await trending.insert({
    repositoryId,
    period: "daily",
    capturedAt: new Date("2026-07-19T00:00:00Z"),
    rank: 1,
    starsInPeriod: 50,
    sourceUrl: "https://github.com/trending",
    collectionStatus: "success",
    jobRunId,
  });
  await posts.upsert({
    productId,
    repositoryId,
    xPostId: "x-1",
    postType: "original",
    authorId: "author-1",
    authorUsername: "ace",
    content: "Ace Hunter",
    postUrl: "https://x.com/ace/status/x-1",
    xCreatedAt: new Date("2026-07-19T00:00:00Z"),
    likes: 0,
    reposts: 0,
    quotes: 0,
    replies: 0,
  });
  const userId = "00000000-0000-4000-8000-000000000091";
  await adminPool.query("insert into auth.users(id) values($1)", [userId]);
  const monitorId = await monitors.upsert({ userId, productId, status: "active" });
  const analysisInput = {
    outputType: "product_analysis",
    userId,
    productId,
    monitorId,
    periodStart: new Date("2026-07-18T00:00:00Z"),
    periodEnd: new Date("2026-07-19T00:00:00Z"),
    dataCutoffAt: new Date("2026-07-19T00:00:00Z"),
    status: "complete",
    title: "Ace Hunter analysis",
    structuredContent: { evidence: [], evaluation: { converted: true } },
    renderedMarkdown: "# Ace Hunter",
    analysisVersion: "v1",
    triggerType: "manual",
    startedAt: new Date("2026-07-19T00:00:00Z"),
    completedAt: new Date("2026-07-19T00:00:00Z"),
    sourceJobRunId: jobRunId,
  } as const;
  const analysisId = await analyses.upsert(analysisInput);
  const repeatedAnalysisId = await analyses.upsert({
    ...analysisInput,
    title: "Ace Hunter analysis rerun",
    structuredContent: { evidence: ["fresh"] },
  });
  expect(repeatedAnalysisId).toBe(analysisId);
  expect(
    (
      await runtimePool.query(
        "select structured_content from ace_hunter.analysis_outputs where id=$1",
        [analysisId],
      )
    ).rows[0].structured_content,
  ).toEqual({ evidence: ["fresh"], evaluation: { converted: true } });

  const counts = await runtimePool.query(
    `select
      (select count(*)::int from ace_hunter.products) products,
      (select count(*)::int from ace_hunter.product_repositories) links,
      (select count(*)::int from ace_hunter.github_trending_snapshots) trending,
      (select count(*)::int from ace_hunter.product_x_posts) posts,
      (select count(*)::int from ace_hunter.user_product_monitors) monitors,
      (select count(*)::int from ace_hunter.analysis_outputs) analyses,
      (select count(*)::int from ace_hunter.job_runs) jobs`,
  );
  expect(counts.rows[0]).toEqual({
    products: 1,
    links: 1,
    trending: 1,
    posts: 1,
    monitors: 1,
    analyses: 1,
    jobs: 1,
  });
});
