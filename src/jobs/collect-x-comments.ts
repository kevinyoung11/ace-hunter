import type { Pool } from "pg";
import type { ContentAnalyzer } from "../analysis/content-analyzer.js";
import type { XPostFact, XSourceAdapter } from "../sources/x/x-source.js";
import { JobError, type JobResult } from "./job-runner.js";
import { analyzePostRows, type AnalyzablePostRow } from "./analyze-x-posts.js";
import { upsertPost } from "./collect-x-posts.js";

export interface CollectXCommentsDependencies { pool: Pool; source: XSourceAdapter; analyzer: ContentAnalyzer }
export interface CollectXCommentsOptions { productId: string; observedAt: Date }

interface RootRow {
  x_post_id: string; conversation_id: string; x_created_at: Date; repository_id: string | null;
}

export async function collectXComments(
  dependencies: CollectXCommentsDependencies,
  options: CollectXCommentsOptions,
): Promise<JobResult> {
  validateOptions(options);
  if (!dependencies.source.capabilities().replies) {
    throw new JobError("source_unavailable", false, "X source does not support conversations");
  }
  const roots = (await dependencies.pool.query<RootRow>(`select x_post_id,conversation_id,x_created_at,repository_id
    from ace_hunter.product_x_posts where product_id=$1 and post_type in ('original','article')
      and not is_duplicate and relevance_score>=0.6 and replies>=3 and conversation_id is not null
    order by relevance_score desc,(likes+reposts+quotes+replies) desc,x_created_at desc,x_post_id limit 5`,
  [options.productId])).rows;
  if (roots.length === 0) return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
  const collected = new Map<string, { fact: XPostFact; repositoryId: string | null; rootId: string }>();
  try {
    await dependencies.source.assertAuthenticated();
    for (const root of roots) {
      const replies = await dependencies.source.searchReplies(root.conversation_id, root.x_created_at, 20);
      for (const fact of replies.slice(0, 20)) {
        if (fact.createdAt > options.observedAt) continue;
        if (fact.id === root.x_post_id || collected.has(fact.id)) continue;
        if (fact.inReplyToPostId === null) throw new Error("X reply is missing its parent identifier");
        collected.set(fact.id, { fact, repositoryId: root.repository_id, rootId: root.x_post_id });
      }
    }
  } catch {
    throw new JobError("source_unavailable", true, "X conversation source unavailable");
  }
  const client = await dependencies.pool.connect();
  try {
    await client.query("begin");
    for (const item of collected.values()) await upsertPost(client, {
      productId: options.productId, repositoryId: item.repositoryId, fact: item.fact, postType: "comment",
      observedAt: options.observedAt, matchMethod: "conversation", matchedIdentifier: item.rootId,
      relationSource: "reply", duplicateClusterId: null,
    });
    await client.query("commit");
  } catch (error) {
    try { await client.query("rollback"); } catch { /* preserve primary failure */ }
    throw error;
  } finally { client.release(); }
  if (collected.size === 0) return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
  const postIds = [...collected.keys()];
  const rows = (await dependencies.pool.query<AnalyzablePostRow>(`select id,x_post_id,content,author_username
    from ace_hunter.product_x_posts where product_id=$1 and x_post_id=any($2::text[]) and analyzed_at is null
    order by x_post_id`, [options.productId, postIds])).rows;
  const analysis = await analyzePostRows(dependencies.pool, dependencies.analyzer, rows, options.observedAt);
  return { expected: collected.size, succeeded: collected.size - analysis.failed.length - analysis.skipped,
    failed: analysis.failed, skipped: analysis.skipped };
}

function validateOptions(options: CollectXCommentsOptions): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(options.productId) || !Number.isFinite(options.observedAt.getTime())) {
    throw new JobError("validation_error", false, "invalid X comment collection input");
  }
}
