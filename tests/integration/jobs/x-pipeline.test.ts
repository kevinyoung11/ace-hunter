import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { collectXPosts } from "../../../src/jobs/collect-x-posts.js";
import { analyzeXPosts } from "../../../src/jobs/analyze-x-posts.js";
import { collectXComments } from "../../../src/jobs/collect-x-comments.js";
import type { ContentAnalyzer, PostAnalysis } from "../../../src/analysis/content-analyzer.js";
import type { XPostFact, XSearchInput, XSourceAdapter } from "../../../src/sources/x/x-source.js";
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
beforeEach(async () => await adminPool.query(`truncate ace_hunter.product_x_posts,
  ace_hunter.product_repositories,ace_hunter.repositories,ace_hunter.products cascade`));
afterAll(async () => await Promise.all([adminPool.end(), runtimePool.end(), migratorPool.end()]));

describe("X scheduled pipeline", () => {
  it("uses five ordered seven-day queries, excludes Retweets, caps fifty, and overlaps later success by six hours", async () => {
    const { productId } = await seedProduct();
    const source = new FakeXSource(Array.from({ length: 60 }, (_, index) => post(`p-${index}`, {
      likes: 60 - index, content: index === 59 ? "RT @bot repeated" : `useful ${index}`,
    })));
    const firstAt = new Date("2026-07-19T12:00:00Z");
    const first = await collectXPosts({ pool: runtimePool, source }, { productId, observedAt: firstAt });
    expect(first).toEqual({ expected: 50, succeeded: 50, failed: [], skipped: 0 });
    expect(source.authCalls).toBe(1);
    expect(source.searchCalls).toHaveLength(5);
    expect(source.searchCalls.map((call) => call.query)).toEqual([
      '"https://github.com/owner/repo"', '"owner/repo"', '"repo.dev"', '"Repo" GitHub', '"Repo" "open source"',
    ]);
    expect(source.searchCalls.every((call) => call.since.toISOString() === "2026-07-12T12:00:00.000Z" &&
      call.until.toISOString() === firstAt.toISOString())).toBe(true);
    expect((await runtimePool.query("select count(*)::int count from ace_hunter.product_x_posts")).rows[0].count).toBe(50);
    expect((await runtimePool.query("select x_collection_status,x_last_attempted_at,x_last_success_at,x_last_error_code from ace_hunter.products where id=$1", [productId])).rows[0])
      .toEqual({ x_collection_status: "success_with_results", x_last_attempted_at: firstAt,
        x_last_success_at: firstAt, x_last_error_code: null });

    source.posts = [post("new")];
    const secondAt = new Date("2026-07-19T18:00:00Z");
    await collectXPosts({ pool: runtimePool, source }, { productId, observedAt: secondAt });
    expect(source.searchCalls.slice(-5).every((call) => call.since.toISOString() === "2026-07-19T06:00:00.000Z")).toBe(true);
  });

  it("distinguishes a legal empty search from failure without erasing the last success", async () => {
    const { productId } = await seedProduct();
    const empty = new FakeXSource([]);
    const successAt = new Date("2026-07-19T12:00:00Z");
    expect(await collectXPosts({ pool: runtimePool, source: empty }, { productId, observedAt: successAt }))
      .toEqual({ expected: 0, succeeded: 0, failed: [], skipped: 0 });
    expect((await productXStatus(productId))).toMatchObject({ x_collection_status: "success_empty", x_last_success_at: successAt });
    empty.searchError = new Error("credential details must never persist");
    const failedAt = new Date("2026-07-19T18:00:00Z");
    await expect(collectXPosts({ pool: runtimePool, source: empty }, { productId, observedAt: failedAt }))
      .rejects.toMatchObject({ code: "source_unavailable" });
    expect(await productXStatus(productId)).toEqual({ x_collection_status: "unavailable",
      x_last_attempted_at: failedAt, x_last_success_at: successAt, x_last_error_code: "source_unavailable" });
  });

  it("clusters duplicate content and analyzes at most thirty nonduplicate originals", async () => {
    const { productId } = await seedProduct();
    const source = new FakeXSource([
      post("leader", { content: "Launch https://repo.dev now", likes: 100 }),
      post("copy", { content: " launch   now ", likes: 99 }),
      ...Array.from({ length: 35 }, (_, index) => post(`unique-${index}`, { content: `unique ${index}`, likes: 90 - index })),
    ]);
    await collectXPosts({ pool: runtimePool, source }, { productId, observedAt: new Date("2026-07-19T12:00:00Z") });
    const duplicate = (await runtimePool.query("select is_duplicate,duplicate_cluster_id from ace_hunter.product_x_posts where x_post_id='copy'")).rows[0];
    expect(duplicate).toEqual({ is_duplicate: true, duplicate_cluster_id: "leader" });
    const analyzer = new FakeAnalyzer();
    const result = await analyzeXPosts({ pool: runtimePool, analyzer }, {
      productId, observedAt: new Date("2026-07-19T12:05:00Z"),
    });
    expect(result.expected).toBe(30);
    expect(analyzer.calls.flat()).toHaveLength(30);
    expect(analyzer.calls.flat()).not.toContain("copy");
    expect((await runtimePool.query("select count(*)::int count from ace_hunter.product_x_posts where analyzed_at is not null")).rows[0].count).toBe(30);
  });

  it("clusters normalized duplicate content against facts retained from an earlier collection", async () => {
    const { productId } = await seedProduct();
    const source = new FakeXSource([post("first", { content: "Install it at https://repo.dev today" })]);
    await collectXPosts({ pool: runtimePool, source }, { productId, observedAt: new Date("2026-07-19T12:00:00Z") });
    source.posts = [post("later-copy", { content: "  install it at today  " })];
    await collectXPosts({ pool: runtimePool, source }, { productId, observedAt: new Date("2026-07-19T18:00:00Z") });
    expect((await runtimePool.query(`select is_duplicate,duplicate_cluster_id from ace_hunter.product_x_posts
      where product_id=$1 and x_post_id='later-copy'`, [productId])).rows[0])
      .toEqual({ is_duplicate: true, duplicate_cluster_id: "first" });
  });

  it("does not turn an overlapped post into a duplicate of itself", async () => {
    const { productId } = await seedProduct();
    const source = new FakeXSource([post("same", { content: "same content" })]);
    await collectXPosts({ pool: runtimePool, source }, { productId, observedAt: new Date("2026-07-19T12:00:00Z") });
    await collectXPosts({ pool: runtimePool, source }, { productId, observedAt: new Date("2026-07-19T18:00:00Z") });
    expect((await runtimePool.query(`select is_duplicate,duplicate_cluster_id from ace_hunter.product_x_posts
      where product_id=$1 and x_post_id='same'`, [productId])).rows[0])
      .toEqual({ is_duplicate: false, duplicate_cluster_id: null });
  });

  it("expands an Article shell before persistence", async () => {
    const { productId } = await seedProduct();
    const source = new FakeXSource([post("article", { content: "shell", isArticle: true })]);
    source.articleText = "complete article body";
    await collectXPosts({ pool: runtimePool, source }, { productId, observedAt: new Date("2026-07-19T12:00:00Z") });
    expect(source.articleCalls).toEqual(["article"]);
    expect((await runtimePool.query("select post_type,content from ace_hunter.product_x_posts where x_post_id='article'")).rows[0])
      .toEqual({ post_type: "article", content: "complete article body" });
  });

  it("does not let an older in-flight collection roll back a newer Product status", async () => {
    const { productId } = await seedProduct();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const old = new FakeXSource([]);
    let first = true;
    old.beforeSearch = async () => { if (first) { first = false; started(); await barrier; } };
    const oldRun = collectXPosts({ pool: runtimePool, source: old }, {
      productId, observedAt: new Date("2026-07-19T12:00:00Z"),
    });
    await waiting;
    await collectXPosts({ pool: runtimePool, source: new FakeXSource([post("newer")]) }, {
      productId, observedAt: new Date("2026-07-19T18:00:00Z"),
    });
    release();
    await oldRun;
    expect(await productXStatus(productId)).toEqual({ x_collection_status: "success_with_results",
      x_last_attempted_at: new Date("2026-07-19T18:00:00Z"), x_last_success_at: new Date("2026-07-19T18:00:00Z"),
      x_last_error_code: null });
  });

  it("persists validated model partial results and reports every malformed item", async () => {
    const { productId } = await seedProduct();
    await collectXPosts({ pool: runtimePool, source: new FakeXSource([post("good"), post("bad")]) }, {
      productId, observedAt: new Date("2026-07-19T12:00:00Z"),
    });
    const analyzer: ContentAnalyzer = { analyze: async () => {
      throw Object.assign(new Error("safe partial"), {
        code: "malformed_model_output",
        partialResults: [{ postId: "good", relevanceScore: 0.9, topic: "usage", sentiment: "positive" as const,
          stance: "support" as const, automationProbability: 0.1, isProjectAffiliated: false }],
        failedPostIds: ["bad"],
      });
    } };
    const result = await analyzeXPosts({ pool: runtimePool, analyzer }, {
      productId, observedAt: new Date("2026-07-19T12:05:00Z"),
    });
    expect(result).toEqual({ expected: 2, succeeded: 1, failed: [{ id: "bad", code: "invalid_data" }], skipped: 0 });
    expect((await runtimePool.query("select x_post_id,analyzed_at from ace_hunter.product_x_posts order by x_post_id")).rows)
      .toEqual([{ x_post_id: "bad", analyzed_at: null }, { x_post_id: "good", analyzed_at: new Date("2026-07-19T12:05:00Z") }]);
  });

  it("escalates model transport failures so JobRunner can retry", async () => {
    const { productId } = await seedProduct();
    await collectXPosts({ pool: runtimePool, source: new FakeXSource([post("retry-me")]) }, {
      productId, observedAt: new Date("2026-07-19T12:00:00Z"),
    });
    const analyzer: ContentAnalyzer = { analyze: async () => {
      throw Object.assign(new Error("safe unavailable"), { code: "model_unavailable",
        partialResults: [], failedPostIds: ["retry-me"] });
    } };
    await expect(analyzeXPosts({ pool: runtimePool, analyzer }, {
      productId, observedAt: new Date("2026-07-19T12:05:00Z"),
    })).rejects.toMatchObject({ code: "source_unavailable", retryable: true });
  });

  it("collects at most twenty comments for the five best eligible roots and analyzes every persisted comment", async () => {
    const { productId } = await seedProduct();
    for (let index = 0; index < 7; index += 1) {
      await insertAnalyzedOriginal(productId, post(`root-${index}`, { replies: index === 0 ? 2 : 30, likes: 100 - index }), 0.95 - index * 0.01);
    }
    const source = new FakeXSource([]);
    source.replyFactory = (conversationId) => Array.from({ length: 25 }, (_, index) => post(`${conversationId}-reply-${index}`, {
      conversationId, rootPostId: conversationId, inReplyToPostId: conversationId, content: `reply ${index}`,
    }));
    const analyzer = new FakeAnalyzer();
    const result = await collectXComments({ pool: runtimePool, source, analyzer }, {
      productId, observedAt: new Date("2026-07-19T13:00:00Z"),
    });
    expect(source.replyCalls).toHaveLength(5);
    expect(source.replyCalls.map((call) => call.conversationId)).not.toContain("root-0");
    expect(source.replyCalls.every((call) => call.limit === 20)).toBe(true);
    expect(result).toMatchObject({ expected: 100, succeeded: 100, failed: [], skipped: 0 });
    expect(analyzer.calls.flat()).toHaveLength(100);
    expect((await runtimePool.query("select count(*)::int count from ace_hunter.product_x_posts where post_type='comment' and analyzed_at is not null")).rows[0].count).toBe(100);
  });
});

class FakeXSource implements XSourceAdapter {
  public authCalls = 0;
  public searchCalls: XSearchInput[] = [];
  public replyCalls: Array<{ conversationId: string; since: Date; limit: number }> = [];
  public searchError: Error | null = null;
  public beforeSearch: () => Promise<void> = async () => undefined;
  public articleCalls: string[] = [];
  public articleText = "article";
  public replyFactory: (conversationId: string) => XPostFact[] = () => [];
  public constructor(public posts: XPostFact[]) {}
  public capabilities() { return { recentSearchDays: 7, replies: true }; }
  public async assertAuthenticated() { this.authCalls += 1; }
  public async searchPosts(input: XSearchInput) {
    this.searchCalls.push(input);
    await this.beforeSearch();
    if (this.searchError) throw this.searchError;
    return this.posts;
  }
  public async searchReplies(conversationId: string, since: Date, limit: number) {
    this.replyCalls.push({ conversationId, since, limit });
    return this.replyFactory(conversationId).slice(0, limit);
  }
  public async getArticle(tweetId: string) { this.articleCalls.push(tweetId); return { articleText: this.articleText }; }
}

class FakeAnalyzer implements ContentAnalyzer {
  public calls: string[][] = [];
  public async analyze(posts: ReadonlyArray<{ id: string; text: string; authorUsername: string }>): Promise<PostAnalysis[]> {
    this.calls.push(posts.map((post) => post.id));
    return posts.map((item) => ({ postId: item.id, relevanceScore: 0.8, topic: "usage", sentiment: "positive",
      stance: "support", automationProbability: 0.1, isProjectAffiliated: false }));
  }
}

function post(id: string, overrides: Partial<XPostFact> = {}): XPostFact {
  return { id, conversationId: id, rootPostId: id, inReplyToPostId: null, authorId: `author-${id}`,
    authorUsername: `user_${id.replace(/[^a-z0-9_]/gi, "_")}`, authorName: "User", authorVerified: false,
    content: `content ${id}`, language: "en", url: `https://x.com/user/status/${encodeURIComponent(id)}`,
    createdAt: new Date("2026-07-19T10:00:00Z"), likes: 1, reposts: 1, quotes: 1, replies: 1,
    bookmarks: null, views: null, ...overrides };
}

async function seedProduct(): Promise<{ productId: string; repositoryId: string }> {
  const repositoryId = (await runtimePool.query<{ id: string }>(`insert into ace_hunter.repositories
    (github_repo_id,owner_login,name,full_name,repo_url,homepage_url,default_branch,topics,has_readme,
     github_created_at,is_fork,is_archived,is_template,is_mirror,status)
    values(1,'owner','repo','owner/repo','https://github.com/owner/repo','https://repo.dev','main','[]',true,
      '2026-07-01',false,false,false,false,'active') returning id`)).rows[0].id;
  const productId = (await runtimePool.query<{ id: string }>(`insert into ace_hunter.products
    (name,website_url,identifiers,status) values('Repo','https://repo.dev','{"domain":"repo.dev"}','active') returning id`)).rows[0].id;
  await runtimePool.query(`insert into ace_hunter.product_repositories(product_id,repository_id,role,is_primary,link_source)
    values($1,$2,'primary',true,'github')`, [productId, repositoryId]);
  return { productId, repositoryId };
}

async function productXStatus(productId: string) {
  return (await runtimePool.query(`select x_collection_status,x_last_attempted_at,x_last_success_at,x_last_error_code
    from ace_hunter.products where id=$1`, [productId])).rows[0];
}

async function insertAnalyzedOriginal(productId: string, fact: XPostFact, relevance: number): Promise<void> {
  await runtimePool.query(`insert into ace_hunter.product_x_posts
    (product_id,x_post_id,conversation_id,root_post_id,post_type,author_id,author_username,author_name,
     author_verified,content,language,post_url,x_created_at,likes,reposts,quotes,replies,relevance_score,
     topic,sentiment,stance,is_duplicate,automation_probability,is_project_affiliated,analysis_version,analyzed_at)
    values($1,$2,$3,$4,'original',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'usage','positive',
      'support',false,0.1,false,'x-v1',now())`, [productId, fact.id, fact.conversationId, fact.rootPostId,
    fact.authorId, fact.authorUsername, fact.authorName, fact.authorVerified, fact.content, fact.language,
    fact.url, fact.createdAt, fact.likes, fact.reposts, fact.quotes, fact.replies, relevance]);
}
