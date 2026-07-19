import type { Pool } from "pg";
import { utcHourBucket } from "../core/time-buckets.js";
import { RepositoryStore } from "../db/stores/repository-store.js";
import { SnapshotStore, type SnapshotInput } from "../db/stores/snapshot-store.js";
import type { Queryable } from "../db/stores/queryable.js";
import { needsAuxRefresh } from "../sources/github/metrics-reader.js";
import { GitHubSourceError, type GitHubMetricSourceFactory, type GitHubMetricSourceOperation } from "../sources/github/github-source.js";
import { JobError, type JobResult } from "./job-runner.js";

export interface RefreshRepoMetricsDependencies { pool: Pool; sourceFactory: GitHubMetricSourceFactory; now?: () => Date }
export interface RefreshRepoMetricsOptions {
  scheduledFor: Date;
  granularity: "hourly" | "realtime";
  repositoryIds?: string[];
  runId?: string;
}

interface RepositoryRow {
  id: string; github_repo_id: string; github_node_id: string | null; full_name: string; default_branch: string; has_readme: boolean;
}
interface PriorAux {
  commits30d: number | null; prTotal: number | null; prOpen: number | null; prMerged: number | null;
  releasesCount: number | null; latestReleaseAt: Date | null; latestReleaseTag: string | null;
  issuesTotal: number | null; issuesOpen: number | null; issuesClosed: number | null;
  auxMetricsCapturedAt: Date | null; candidateBuckets: string[]; candidateRuleVersion: string | null;
}
interface Prepared { repository: RepositoryRow; snapshot: SnapshotInput; due: boolean }

export async function refreshRepoMetrics(
  dependencies: RefreshRepoMetricsDependencies,
  options: RefreshRepoMetricsOptions,
): Promise<JobResult> {
  const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (options.runId !== undefined && !runIdPattern.test(options.runId)) {
    throw new JobError("validation_error", false, "invalid metric job lineage");
  }
  const scheduledMs = options.scheduledFor.getTime();
  if (!Number.isFinite(scheduledMs)) throw new JobError("validation_error", false, "invalid metric capture time");
  if (options.granularity !== "hourly" && options.granularity !== "realtime") {
    throw new JobError("validation_error", false, "invalid metric granularity");
  }
  const observedAt = new Date((dependencies.now ?? (() => new Date()))());
  if (!Number.isFinite(observedAt.getTime())) throw new JobError("validation_error", false, "invalid metric observation time");
  if (options.granularity === "hourly" && utcHourBucket(observedAt).getTime() !== utcHourBucket(options.scheduledFor).getTime()) {
    throw new JobError("validation_error", false, "scheduled metric window has expired");
  }
  if (options.granularity === "realtime" && (!options.repositoryIds || options.repositoryIds.length === 0)) {
    throw new JobError("validation_error", false, "realtime metric refresh requires repository selection");
  }
  const capturedAt = options.granularity === "hourly" ? utcHourBucket(options.scheduledFor) : observedAt;
  const repositories = await readRepositories(dependencies.pool, options.repositoryIds);
  if (repositories.length === 0) return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
  let source: GitHubMetricSourceOperation;
  try { source = await dependencies.sourceFactory.openOperation(); }
  catch (error) { throw toJobError(error); }
  let result: JobResult | undefined;
  let primaryError: unknown;
  try { result = await refreshWithOperation(dependencies.pool, source, repositories, capturedAt, observedAt, options); }
  catch (error) { primaryError = error; }
  try { await source.close(); }
  catch { if (primaryError === undefined) throw new JobError("source_unavailable", true, "github metric operation close failed"); }
  if (primaryError !== undefined) throw primaryError;
  return result!;
}

async function refreshWithOperation(
  pool: Pool,
  source: GitHubMetricSourceOperation,
  repositories: RepositoryRow[],
  capturedAt: Date,
  observedAt: Date,
  options: RefreshRepoMetricsOptions,
): Promise<JobResult> {
  let metricGraphqlRemaining = 0;
  try {
    const limits = await source.getMetricRateLimit();
    if (limits.coreRemaining < repositories.length) throw new GitHubSourceError("request_budget_exhausted");
    metricGraphqlRemaining = limits.graphqlRemaining;
  } catch (error) { throw toJobError(error); }

  const prepared: Prepared[] = [];
  const failed: Array<{ id: string; code: string }> = [];
  // Global phase one: every tracked repository receives Core before any Aux call can consume budget.
  for (const repository of repositories) {
    try {
      const core = await source.getCoreMetrics(repository.full_name, observedAt);
      if (core.metadata.githubRepoId !== Number(repository.github_repo_id) ||
          (repository.github_node_id !== null && core.metadata.nodeId !== repository.github_node_id) ||
          core.capturedAt.getTime() !== observedAt.getTime()) throw new GitHubSourceError("repository_identity_mismatch");
      const client = await pool.connect();
      let prior: PriorAux;
      const metadata = { ...core.metadata, hasReadme: repository.has_readme };
      try {
      await client.query("begin");
      prior = await readPriorAux(client, repository.id, capturedAt);
      const persistedId = await new RepositoryStore(client).upsert({
        githubRepoId: metadata.githubRepoId, githubNodeId: metadata.nodeId, ownerId: metadata.ownerId,
        ownerLogin: metadata.ownerLogin, ownerType: metadata.ownerType, ownerProfileUrl: metadata.ownerProfileUrl,
        ownerAvatarUrl: metadata.ownerAvatarUrl, name: metadata.name, fullName: metadata.fullName,
        description: metadata.description, repoUrl: metadata.repoUrl, homepageUrl: metadata.homepageUrl,
        defaultBranch: metadata.defaultBranch, language: metadata.language, license: metadata.license,
        topics: metadata.topics, hasReadme: metadata.hasReadme, githubCreatedAt: metadata.createdAt,
        githubPushedAt: metadata.pushedAt, isFork: metadata.isFork, isArchived: metadata.isArchived,
        isTemplate: metadata.isTemplate, isMirror: metadata.isMirror,
      });
      if (persistedId !== repository.id) throw new GitHubSourceError("repository_identity_mismatch");
      const due = options.granularity === "realtime" || needsAuxRefresh(prior.auxMetricsCapturedAt, observedAt);
      const snapshot: SnapshotInput = {
        repositoryId: repository.id, capturedAt, granularity: options.granularity, stars: core.stars, forks: core.forks,
        commits30d: prior.commits30d, prTotal: prior.prTotal, prOpen: prior.prOpen, prMerged: prior.prMerged,
        releasesCount: prior.releasesCount, latestReleaseAt: prior.latestReleaseAt, latestReleaseTag: prior.latestReleaseTag,
        issuesTotal: prior.issuesTotal, issuesOpen: prior.issuesOpen, issuesClosed: prior.issuesClosed,
        auxMetricsCapturedAt: prior.auxMetricsCapturedAt, candidateBuckets: prior.candidateBuckets,
        candidateRuleVersion: prior.candidateRuleVersion,
        collectedFields: { core: true, aux: prior.auxMetricsCapturedAt !== null, aux_reused: prior.auxMetricsCapturedAt !== null,
          source_job_run_id: options.runId ?? null, observed_at: observedAt.toISOString(),
          metadata: {
            name: metadata.name, full_name: metadata.fullName, description: metadata.description,
            repo_url: metadata.repoUrl, homepage_url: metadata.homepageUrl,
          },
          aux_window_start: prior.auxMetricsCapturedAt ? new Date(prior.auxMetricsCapturedAt.getTime() - 30 * 86_400_000).toISOString() : null,
          aux_window_end: prior.auxMetricsCapturedAt?.toISOString() ?? null },
      };
      await new SnapshotStore(client).insert(snapshot);
      await client.query("commit");
      prepared.push({ repository: { ...repository, full_name: metadata.fullName, default_branch: metadata.defaultBranch }, snapshot, due });
      } catch (error) {
        try { await client.query("rollback"); } catch { /* preserve primary failure */ }
        throw error;
      } finally { client.release(); }
    } catch (error) {
      if (isBudgetError(error)) throw toJobError(error);
      if (isSystemic(error)) throw toJobError(error);
      failed.push({ id: repository.id, code: itemCode(error) });
    }
  }

  const due = prepared.filter((item) => item.due);
  let auxBudgetExhausted = false;
  if (metricGraphqlRemaining === 0 && due.length > 0) {
    for (const item of due) failed.push({ id: item.repository.id, code: "aux_budget_exhausted" });
    auxBudgetExhausted = true;
  }
  for (let index = 0; !auxBudgetExhausted && index < due.length; index += 1) {
    const item = due[index];
    try {
      const aux = await source.getAuxMetrics(item.repository.full_name, item.repository.default_branch, observedAt);
      if (aux.capturedAt.getTime() !== observedAt.getTime()) throw new GitHubSourceError("response_invalid");
      await new SnapshotStore(pool).insert({ ...item.snapshot,
        commits30d: aux.commits30d, prTotal: aux.prTotal, prOpen: aux.prOpen, prMerged: aux.prMerged,
        releasesCount: aux.releasesCount, latestReleaseAt: aux.latestReleaseAt, latestReleaseTag: aux.latestReleaseTag,
        issuesTotal: aux.issuesTotal, issuesOpen: aux.issuesOpen, issuesClosed: aux.issuesClosed,
        auxMetricsCapturedAt: aux.capturedAt,
        collectedFields: { core: true, aux: true, aux_reused: false, source_job_run_id: options.runId ?? null,
          observed_at: observedAt.toISOString(), aux_window_start: new Date(observedAt.getTime() - 30 * 86_400_000).toISOString(),
          aux_window_end: observedAt.toISOString() },
      });
    } catch (error) {
      if (isBudgetError(error)) {
        for (const remaining of due.slice(index)) failed.push({ id: remaining.repository.id, code: "aux_budget_exhausted" });
        auxBudgetExhausted = true;
        break;
      }
      if (isSystemic(error)) throw toJobError(error);
      failed.push({ id: item.repository.id, code: itemCode(error) });
    }
  }
  const failedIds = new Set(failed.map((item) => item.id));
  return { expected: repositories.length, succeeded: prepared.filter((item) => !failedIds.has(item.repository.id)).length,
    failed, skipped: 0 };
}

async function readRepositories(pool: Pool, ids?: string[]): Promise<RepositoryRow[]> {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ids && (ids.length > 1_000 || new Set(ids).size !== ids.length || ids.some((id) => !uuidPattern.test(id)))) {
    throw new JobError("validation_error", false, "invalid repository selection");
  }
  const result = await pool.query<RepositoryRow>(`select id,github_repo_id,github_node_id,full_name,default_branch,has_readme
    from ace_hunter.repositories where status='active' and ($1::uuid[] is null or id=any($1)) order by full_name,id`, [ids ?? null]);
  if (ids !== undefined && result.rows.length !== ids.length) {
    throw new JobError("validation_error", false, "repository selection is missing or inactive");
  }
  return result.rows;
}

async function readPriorAux(pool: Queryable, repositoryId: string, capturedAt: Date): Promise<PriorAux> {
  const result = await pool.query(`select commits_30d,pr_total,pr_open,pr_merged,releases_count,latest_release_at,
      latest_release_tag,issues_total,issues_open,issues_closed,aux_metrics_captured_at,candidate_buckets,candidate_rule_version
    from ace_hunter.repository_snapshots where repository_id=$1 and captured_at<=$2
    order by aux_metrics_captured_at desc nulls last,captured_at desc limit 1`, [repositoryId, capturedAt]);
  const row = result.rows[0];
  return row ? { commits30d: row.commits_30d, prTotal: row.pr_total, prOpen: row.pr_open, prMerged: row.pr_merged,
    releasesCount: row.releases_count, latestReleaseAt: row.latest_release_at, latestReleaseTag: row.latest_release_tag,
    issuesTotal: row.issues_total, issuesOpen: row.issues_open, issuesClosed: row.issues_closed,
    auxMetricsCapturedAt: row.aux_metrics_captured_at, candidateBuckets: row.candidate_buckets,
    candidateRuleVersion: row.candidate_rule_version } : {
    commits30d: null, prTotal: null, prOpen: null, prMerged: null, releasesCount: null,
    latestReleaseAt: null, latestReleaseTag: null, issuesTotal: null, issuesOpen: null, issuesClosed: null,
    auxMetricsCapturedAt: null, candidateBuckets: [], candidateRuleVersion: null,
  };
}

function isBudgetError(error: unknown): boolean {
  return error instanceof GitHubSourceError && (error.code === "rate_limit" || error.code.includes("budget"));
}
function isSystemic(error: unknown): boolean {
  return !(error instanceof GitHubSourceError) || !new Set(["not_found", "repository_inaccessible", "repository_invalid", "repository_identity_mismatch", "pagination_limit_exceeded", "default_branch_mismatch", "request_budget_exhausted", "rate_limit"]).has(error.code);
}
function itemCode(error: unknown): string {
  if (!(error instanceof GitHubSourceError)) return "item_failed";
  if (error.code === "not_found" || error.code === "repository_inaccessible") return "not_found";
  return "invalid_data";
}
function toJobError(error: unknown): JobError {
  const code = error instanceof GitHubSourceError ? error.code : "source_unavailable";
  if (code.includes("budget") || code.includes("rate")) return new JobError("rate_limit", true, "github metric budget exhausted");
  if (code.includes("auth")) return new JobError("authentication_error", false, "github authentication failed");
  if (code.includes("timeout")) return new JobError("timeout", true, "github metric request timed out");
  if (code.includes("network")) return new JobError("network_error", true, "github metric source unavailable");
  return new JobError("source_unavailable", true, "github metric source unavailable");
}
