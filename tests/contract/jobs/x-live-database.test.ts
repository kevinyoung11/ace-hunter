import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { TwitterCliSource } from "../../../src/sources/x/twitter-cli-source.js";
import { ModelContentAnalyzer } from "../../../src/analysis/model-content-analyzer.js";
import { collectXPosts } from "../../../src/jobs/collect-x-posts.js";
import { analyzeXPosts } from "../../../src/jobs/analyze-x-posts.js";
import { JobRunner } from "../../../src/jobs/job-runner.js";

const live = process.env.RUN_LIVE_X_DATABASE_CONTRACT === "1" ? describe : describe.skip;

live("live X database pipeline", () => {
  it("collects a real repository discussion and persists one real model analysis", async () => {
    const adminUrl = required("ACE_TEST_ADMIN_DATABASE_URL");
    const runtimeUrl = required("ACE_TEST_RUNTIME_DATABASE_URL");
    const modelKey = required("ACE_HUNTER_DEEPSEEK_API_KEY");
    const admin = new Pool({ connectionString: adminUrl });
    const runtime = new Pool({ connectionString: runtimeUrl });
    const lockPool = new Pool({ connectionString: runtimeUrl, max: 2 });
    try {
      await admin.query(`truncate ace_hunter.product_x_posts,ace_hunter.product_repositories,
        ace_hunter.job_runs,ace_hunter.repositories,ace_hunter.products cascade`);
      const repositoryId = (await runtime.query<{ id: string }>(`insert into ace_hunter.repositories
        (github_repo_id,owner_login,name,full_name,repo_url,default_branch,topics,has_readme,github_created_at,
         is_fork,is_archived,is_template,is_mirror,status)
        values(9000001,'xai-org','grok-build','xai-org/grok-build','https://github.com/xai-org/grok-build',
          'main','[]',true,now(),false,false,false,false,'active') returning id`)).rows[0].id;
      const productId = (await runtime.query<{ id: string }>(`insert into ace_hunter.products
        (name,identifiers,status) values('Grok Build','{}','active') returning id`)).rows[0].id;
      await runtime.query(`insert into ace_hunter.product_repositories(product_id,repository_id,role,is_primary,link_source)
        values($1,$2,'primary',true,'live-contract')`, [productId, repositoryId]);
      const source = new TwitterCliSource({ cliPath: process.env.TWITTER_CLI_PATH ?? "/Users/apulu/.local/bin/twitter" });
      const observedAt = new Date();
      const runner = new JobRunner(runtime, { lockPool, loadedSecrets: [], clock: {
        now: () => new Date(observedAt), sleep: async () => undefined,
      } });
      const collected = await runner.run({ name: "collect_x_posts", triggerType: "manual", scheduledFor: observedAt,
        parameters: { productId }, dataCutoffAt: observedAt }, async () =>
        await collectXPosts({ pool: runtime, source }, { productId, observedAt }));
      expect(collected.status).toBe("success");
      expect((await runtime.query("select x_collection_status from ace_hunter.products where id=$1", [productId])).rows[0].x_collection_status)
        .toBe("success_with_results");
      await runtime.query(`delete from ace_hunter.product_x_posts where product_id=$1 and id not in
        (select id from ace_hunter.product_x_posts where product_id=$1 and not is_duplicate
         order by (likes+reposts+quotes+replies) desc,x_created_at desc limit 1)`, [productId]);
      const analyzer = new ModelContentAnalyzer({ apiKey: modelKey,
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat", timeoutMs: 60_000 });
      const analyzed = await analyzeXPosts({ pool: runtime, analyzer }, { productId, observedAt: new Date() });
      expect(analyzed).toMatchObject({ expected: 1, succeeded: 1, failed: [] });
      expect((await runtime.query(`select analysis_version,model_name,relevance_score from ace_hunter.product_x_posts
        where product_id=$1`, [productId])).rows[0]).toMatchObject({
        analysis_version: "x-v1", model_name: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
        relevance_score: expect.any(String),
      });
    } finally {
      await Promise.all([admin.end(), runtime.end(), lockPool.end()]);
    }
  }, 180_000);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
