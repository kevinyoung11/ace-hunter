import type { Pool } from "pg";
import type { ContentAnalyzer } from "../analysis/content-analyzer.js";
import { analyzeXPosts } from "../jobs/analyze-x-posts.js";
import { collectGithubTrending } from "../jobs/collect-github-trending.js";
import { collectXComments } from "../jobs/collect-x-comments.js";
import { collectXPosts } from "../jobs/collect-x-posts.js";
import { discoverGithubCandidates } from "../jobs/discover-github-candidates.js";
import { evaluateClosedCohorts } from "../jobs/evaluate-success.js";
import { generateReport } from "../jobs/generate-report.js";
import {
  JobError,
  JobRunner,
  type JobContext,
  type JobInput,
  type JobResult,
} from "../jobs/job-runner.js";
import { refreshRepoMetrics } from "../jobs/refresh-repo-metrics.js";
import { compactSnapshots } from "../jobs/retention.js";
import type {
  GitHubMetricSourceFactory,
  GitHubSourceFactory,
} from "../sources/github/github-source.js";
import type { TrendingSource } from "../sources/trending/trending-source.js";
import type { XSourceAdapter } from "../sources/x/x-source.js";
import type { CommandOutput } from "./output.js";
import { validateJobRequest } from "../ops/job-catalog.js";

export interface JobDispatcherDependencies {
  pool: Pool;
  lockPool: Pool;
  loadedSecrets: readonly string[];
  githubSourceFactory: GitHubSourceFactory & GitHubMetricSourceFactory;
  trendingSource: TrendingSource;
  xSource: XSourceAdapter;
  analyzer: ContentAnalyzer | null;
  cleanupX?: () => Promise<void>;
}

export type JobDispatcher = (input: JobInput) => Promise<CommandOutput & {
  runId: string;
  status: string;
  executed: boolean;
}>;

export function createJobDispatcher(
  dependencies: JobDispatcherDependencies,
): JobDispatcher {
  const runner = new JobRunner(dependencies.pool, {
    lockPool: dependencies.lockPool,
    loadedSecrets: dependencies.loadedSecrets,
  });
  return async (input) => {
    // The dispatcher is also an execution boundary for hosted commands: never
    // allow an unregistered job name or a caller-supplied executor/capability.
    validateJobRequest({ name: input.name, parameters: input.parameters });
    let outcome;
    try {
      outcome = await runner.run(input, async (context) =>
        dispatch(dependencies, runner, input, context));
    } catch (error) {
      if (error instanceof Error && /^job failed \([a-z_]+\)$/u.test(error.message)) {
        throw Object.assign(new Error("job failed"), { code: "job_failed" });
      }
      throw error;
    }
    if (outcome.status === "failed") {
      throw Object.assign(new Error("job failed"), { code: "job_failed", runId: outcome.runId });
    }
    return { kind: "job_run", ...outcome };
  };
}

async function dispatch(
  dependencies: JobDispatcherDependencies,
  runner: JobRunner,
  input: JobInput,
  context: JobContext,
): Promise<JobResult> {
  switch (input.name) {
    case "discover_github_candidates":
      return discoverGithubCandidates({
        pool: dependencies.pool,
        sourceFactory: dependencies.githubSourceFactory,
        emitOperationalEvent: () => undefined,
      }, context.scheduledFor, {
        runId: context.runId,
        maxNew: optionalInteger(input.parameters.max_new),
      });
    case "collect_github_trending":
      return collectGithubTrending({
        pool: dependencies.pool,
        sourceFactory: dependencies.githubSourceFactory,
        trendingSource: dependencies.trendingSource,
      }, {
        period: trendingPeriod(input.parameters.period),
        scheduledFor: context.scheduledFor,
        runId: context.runId,
      });
    case "refresh_repo_metrics":
      return refreshRepoMetrics({
        pool: dependencies.pool,
        sourceFactory: dependencies.githubSourceFactory,
      }, {
        scheduledFor: context.scheduledFor,
        granularity: "hourly",
        runId: context.runId,
      });
    case "collect_x_posts":
      return withXCleanup(dependencies, () => runProductBatch(dependencies.pool, runner, input, context, "collect_x_posts",
        (productId) => collectXPosts({ pool: dependencies.pool, source: dependencies.xSource }, {
          productId, observedAt: context.scheduledFor,
        }), "collect"));
    case "analyze_x_posts":
      return withXCleanup(dependencies, () => runProductBatch(dependencies.pool, runner, input, context, "analyze_x_posts",
        (productId) => analyzeXPosts({ pool: dependencies.pool, analyzer: requireAnalyzer(dependencies.analyzer) }, {
          productId, observedAt: context.scheduledFor,
        }), "downstream"));
    case "collect_x_comments": {
      const lineage = await loadOrFreezeCommentLineage(dependencies.pool, context.runId, input.parameters);
      return withXCleanup(dependencies, () => runProductBatch(dependencies.pool, runner, input, context, "collect_x_comments",
        (productId) => collectXComments({
          pool: dependencies.pool,
          source: dependencies.xSource,
          analyzer: requireAnalyzer(dependencies.analyzer),
        }, { productId, observedAt: context.scheduledFor, rootPostIds: lineage.rootPostIds }),
        "downstream",
        lineage.productIds,
        { product_ids: lineage.productIds, root_post_ids: lineage.rootPostIds }));
    }
    case "generate_report": {
      const cutoff = reportCutoff(context.scheduledFor, input.parameters.cutoff_hour_utc);
      const generated = await generateReport({ pool: dependencies.pool }, cutoff);
      return { expected: generated.report.items.length, succeeded: generated.report.items.length, failed: [], skipped: 0 };
    }
    case "retention": {
      const result = await compactSnapshots(dependencies.pool, context.scheduledFor);
      const count = result.snapshotsDeleted + result.jobRunsDeleted;
      return { expected: count, succeeded: count, failed: [], skipped: 0 };
    }
    case "evaluate_success": {
      const evaluation = await evaluateClosedCohorts(dependencies.pool, context.scheduledFor, {
        sourceJobRunId: context.runId,
      });
      return {
        expected: evaluation.status === "not_enough_history" ? 1 : evaluation.cohortCount,
        succeeded: evaluation.status === "not_enough_history" ? 1 : evaluation.cohortCount,
        failed: [],
        skipped: 0,
      };
    }
    default:
      throw new JobError("validation_error", false, "unsupported job name");
  }
}

async function withXCleanup<T>(dependencies: JobDispatcherDependencies, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await dependencies.cleanupX?.();
  }
}

async function runProductBatch(
  pool: Pool,
  runner: JobRunner,
  parentInput: JobInput,
  parentContext: JobContext,
  name: string,
  handler: (productId: string) => Promise<JobResult>,
  selectionPhase: XBatchPhase,
  productIdsOverride?: readonly string[],
  frozenParameters: Record<string, unknown> = {},
): Promise<JobResult> {
  if (typeof parentInput.parameters.productId === "string") {
    return handler(parentInput.parameters.productId);
  }
  const productIds = productIdsOverride === undefined
    ? await selectXBatchProductIds(pool, selectionPhase)
    : [...productIdsOverride];
  const failed: Array<{ id: string; code: string }> = [];
  let succeeded = 0;
  for (const productId of productIds) {
    const child = await runner.run({
      name,
      triggerType: parentInput.triggerType,
      scheduledFor: parentContext.scheduledFor,
      parameters: { ...parentInput.parameters, ...frozenParameters, productId },
      parentRunId: parentContext.runId,
      dataCutoffAt: parentInput.dataCutoffAt,
    }, () => handler(productId));
    if (child.status === "success") succeeded += 1;
    else failed.push({ id: productId, code: "item_failed" });
  }
  return { expected: productIds.length, succeeded, failed, skipped: 0 };
}

async function loadOrFreezeCommentLineage(
  pool: Pool,
  runId: string,
  inputParameters: Record<string, unknown>,
): Promise<{ productIds: string[]; rootPostIds: string[] }> {
  if (typeof inputParameters.productId === "string") {
    const frozenRoots = Array.isArray(inputParameters.root_post_ids)
      ? inputParameters.root_post_ids.filter((value): value is string => typeof value === "string")
      : null;
    if (frozenRoots) return { productIds: [inputParameters.productId], rootPostIds: frozenRoots };
    const roots = await selectedCommentRoots(pool, [inputParameters.productId]);
    return { productIds: [inputParameters.productId], rootPostIds: roots.map((row) => row.x_post_id) };
  }
  const stored = await pool.query<{ parameters: Record<string, unknown> }>(
    "select parameters from ace_hunter.job_runs where id=$1", [runId],
  );
  const parameters = stored.rows[0]?.parameters;
  if (!parameters) throw new JobError("invalid_data", false, "comment lineage run missing");
  if (Array.isArray(parameters.product_ids) && Array.isArray(parameters.root_post_ids)) {
    return {
      productIds: parameters.product_ids.filter((value): value is string => typeof value === "string"),
      rootPostIds: parameters.root_post_ids.filter((value): value is string => typeof value === "string"),
    };
  }
  const activeProductIds = await selectXBatchProductIds(pool, "downstream");
  const roots = await selectedCommentRoots(pool, activeProductIds);
  const productIds = [...new Set(roots.map((row) => row.product_id))];
  const rootPostIds = [...new Set(roots.map((row) => row.x_post_id))];
  const updated = await pool.query(`update ace_hunter.job_runs
    set parameters=parameters || $2::jsonb where id=$1 and job_name='collect_x_comments'`,
  [runId, JSON.stringify({ product_ids: productIds, root_post_ids: rootPostIds })]);
  if (updated.rowCount !== 1) throw new JobError("invalid_data", false, "comment lineage write conflict");
  return { productIds, rootPostIds };
}

const xBatchSize = 3;
type XBatchPhase = "collect" | "downstream";

export async function selectXBatchProductIds(
  pool: Pick<Pool, "query">,
  phase: XBatchPhase,
): Promise<string[]> {
  const attemptedPredicate = phase === "downstream" ? "and p.x_last_attempted_at is not null" : "";
  const attemptOrder = phase === "collect"
    ? "p.x_last_attempted_at asc nulls first,p.updated_at desc"
    : "p.x_last_attempted_at desc";
  const result = await pool.query<{ id: string }>(`select p.id from ace_hunter.products p
    where p.status='active' ${attemptedPredicate}
    order by exists(select 1 from ace_hunter.user_product_monitors m
      where m.product_id=p.id and m.status='active') desc,
      ${attemptOrder},p.id
    limit $1`, [xBatchSize]);
  return result.rows.slice(0, xBatchSize).map((row) => row.id);
}

async function selectedCommentRoots(
  pool: Pool,
  productIds: readonly string[],
): Promise<Array<{ product_id: string; x_post_id: string }>> {
  if (productIds.length === 0) return [];
  return (await pool.query<{ product_id: string; x_post_id: string }>(`select product_id,x_post_id from (
      select product_id,x_post_id,row_number() over(partition by product_id
        order by relevance_score desc,(likes+reposts+quotes+replies) desc,x_created_at desc,x_post_id) selection_rank
      from ace_hunter.product_x_posts
      where product_id=any($1::uuid[]) and post_type in ('original','article') and not is_duplicate
        and relevance_score>=0.6 and replies>=3 and conversation_id is not null
    ) selected where selection_rank<=5 order by product_id,selection_rank`, [productIds])).rows;
}

function trendingPeriod(value: unknown): "daily" | "weekly" | "monthly" {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  throw new JobError("validation_error", false, "trending period is required");
}

function reportCutoff(scheduledFor: Date, rawHour: unknown): Date {
  const hour = rawHour === undefined ? 0 : rawHour;
  if (!Number.isInteger(hour) || Number(hour) < 0 || Number(hour) > 23) {
    throw new JobError("validation_error", false, "invalid report cutoff hour");
  }
  const cutoff = new Date(Date.UTC(
    scheduledFor.getUTCFullYear(),
    scheduledFor.getUTCMonth(),
    scheduledFor.getUTCDate(),
    Number(hour),
  ));
  if (cutoff > scheduledFor || Number(hour) !== 0) {
    throw new JobError("validation_error", false, "daily report cutoff must be 08:00 Asia/Shanghai");
  }
  return cutoff;
}

function requireAnalyzer(analyzer: ContentAnalyzer | null): ContentAnalyzer {
  if (!analyzer) throw new JobError("authentication_error", false, "content analyzer is not configured");
  return analyzer;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new JobError("validation_error", false, "invalid integer parameter");
  return Number(value);
}
