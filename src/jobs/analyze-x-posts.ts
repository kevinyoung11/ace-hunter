import type { Pool, PoolClient } from "pg";
import type { ContentAnalyzer, PostAnalysis } from "../analysis/content-analyzer.js";
import { JobError, type JobResult } from "./job-runner.js";

export interface AnalyzeXPostsDependencies { pool: Pool; analyzer: ContentAnalyzer }
export interface AnalyzeXPostsOptions { productId: string; observedAt: Date }
export interface AnalyzablePostRow { id: string; x_post_id: string; content: string; author_username: string }

export async function analyzeXPosts(
  dependencies: AnalyzeXPostsDependencies,
  options: AnalyzeXPostsOptions,
): Promise<JobResult> {
  validateOptions(options);
  const rows = (await dependencies.pool.query<AnalyzablePostRow>(`select id,x_post_id,content,author_username
    from ace_hunter.product_x_posts where product_id=$1 and post_type in ('original','article')
      and not is_duplicate and analyzed_at is null
    order by (likes+reposts+quotes+replies) desc,x_created_at desc,x_post_id limit 30`, [options.productId])).rows;
  return analyzePostRows(dependencies.pool, dependencies.analyzer, rows, options.observedAt);
}

export async function analyzePostRows(
  pool: Pool,
  analyzer: ContentAnalyzer,
  rows: AnalyzablePostRow[],
  observedAt: Date,
): Promise<JobResult> {
  if (rows.length === 0) return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
  let analyses: PostAnalysis[];
  let failedIds: string[] = [];
  try {
    analyses = await analyzer.analyze(rows.map((row) => ({ id: row.x_post_id, text: row.content,
      authorUsername: row.author_username })));
  } catch (error) {
    const partial = readPartialFailure(error, new Set(rows.map((row) => row.x_post_id)));
    if (partial === null) throw new JobError("source_unavailable", true, "content analysis unavailable");
    analyses = partial.analyses;
    failedIds = partial.failedIds;
  }
  const byPostId = new Map(rows.map((row) => [row.x_post_id, row]));
  const analysisIds = new Set(analyses.map((item) => item.postId));
  const failedIdSet = new Set(failedIds);
  if (analysisIds.size !== analyses.length || failedIdSet.size !== failedIds.length ||
      analyses.some((item) => !byPostId.has(item.postId) || failedIdSet.has(item.postId)) ||
      failedIds.some((id) => !byPostId.has(id)) || analyses.length + failedIds.length !== rows.length) {
    throw new JobError("source_unavailable", true, "content analysis returned invalid identifiers");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const analysis of analyses) await persistAnalysis(client, byPostId.get(analysis.postId)!.id, analysis, observedAt);
    await client.query("commit");
  } catch (error) {
    try { await client.query("rollback"); } catch { /* preserve primary failure */ }
    throw error;
  } finally { client.release(); }
  return { expected: rows.length, succeeded: analyses.length,
    failed: failedIds.map((id) => ({ id, code: "invalid_data" })), skipped: 0 };
}

async function persistAnalysis(client: PoolClient, rowId: string, analysis: PostAnalysis, observedAt: Date): Promise<void> {
  const metadata = analysis as PostAnalysis & { analysisVersion?: string; modelName?: string };
  await client.query(`update ace_hunter.product_x_posts set relevance_score=$2,topic=$3,sentiment=$4,
      stance=$5,automation_probability=$6,is_project_affiliated=$7,analysis_version=$8,model_name=$9,
      analyzed_at=$10,updated_at=$10 where id=$1`, [rowId, analysis.relevanceScore, analysis.topic,
    analysis.sentiment, analysis.stance, analysis.automationProbability, analysis.isProjectAffiliated,
    metadata.analysisVersion ?? "x-v1", metadata.modelName ?? null, observedAt]);
}

function readPartialFailure(error: unknown, expected: Set<string>): { analyses: PostAnalysis[]; failedIds: string[] } | null {
  if (typeof error !== "object" || error === null) return null;
  const value = error as { code?: unknown; partialResults?: unknown; failedPostIds?: unknown };
  if (value.code !== "malformed_model_output" || !Array.isArray(value.partialResults) || !Array.isArray(value.failedPostIds) ||
      value.failedPostIds.some((id) => typeof id !== "string" || !expected.has(id))) return null;
  return { analyses: value.partialResults as PostAnalysis[], failedIds: value.failedPostIds as string[] };
}

function validateOptions(options: AnalyzeXPostsOptions): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(options.productId) || !Number.isFinite(options.observedAt.getTime())) {
    throw new JobError("validation_error", false, "invalid X analysis input");
  }
}
