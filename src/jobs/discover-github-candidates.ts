import type { Pool } from "pg";
import { utcHourBucket } from "../core/time-buckets.js";
import { SnapshotStore } from "../db/stores/snapshot-store.js";
import { createProductFromRepo, type CapacityReviewOptions } from "../products/create-product-from-repo.js";
import type { GitHubRepository, GitHubSource } from "../sources/github/github-source.js";
import { GitHubSourceError } from "../sources/github/github-source.js";
import { candidateBuckets, searchCompletely } from "../sources/github/repository-search.js";
import { JobError, type JobResult } from "./job-runner.js";

export interface DiscoverGithubDependencies { pool: Pool; source: GitHubSource }
export interface DiscoverGithubOptions extends CapacityReviewOptions { runId?: string }

const day = 86_400_000;

export async function discoverGithubCandidates(
  dependencies: DiscoverGithubDependencies,
  at: Date,
  options: DiscoverGithubOptions = {},
): Promise<JobResult> {
  if (!Number.isFinite(at.getTime())) throw new JobError("validation_error", false, "invalid discovery time");
  const searchAt = new Date(Math.floor(at.getTime() / 1_000) * 1_000);
  if (options.reviewedCapacityOverride === true && (!options.capacityReviewId || !options.runId)) {
    throw new JobError("validation_error", false, "capacity review audit required");
  }
  let rateLimit: { remaining: number; resetAt: Date };
  try { rateLimit = await dependencies.source.getRateLimit(); }
  catch { throw new JobError("source_unavailable", true, "github source unavailable"); }
  if (rateLimit.remaining < 1) throw new JobError("rate_limit", true, "github search rate limited");

  const rules = [
    { from: new Date(searchAt.getTime() - day), to: searchAt, minStars: 10 },
    { from: new Date(searchAt.getTime() - 7 * day), to: searchAt, minStars: 100 },
    { from: new Date(searchAt.getTime() - 30 * day), to: searchAt, minStars: 1_000 },
  ];
  const found = new Map<number, GitHubRepository>();
  try {
    for (const rule of rules) {
      for (const repository of await searchCompletely(dependencies.source, rule)) {
        const previous = found.get(repository.githubRepoId);
        if (previous && previous.fullName !== repository.fullName) throw new Error("repository_identity_conflict");
        found.set(repository.githubRepoId, repository);
      }
    }
  } catch (error) {
    const code = error instanceof GitHubSourceError && error.code.includes("rate") ? "rate_limit" : "source_unavailable";
    throw new JobError(code, true, "github candidate search incomplete");
  }

  const failed: Array<{ id: string; code: string }> = [];
  let succeeded = 0;
  let skipped = 0;
  for (const searchRepository of found.values()) {
    let repository: GitHubRepository;
    try {
      repository = await dependencies.source.getRepository(searchRepository.fullName);
      if (!repository.description?.trim()) {
        repository = { ...repository, hasReadme: await dependencies.source.hasReadme(repository.fullName) };
      }
    } catch (error) {
      failed.push({ id: safeItemId(searchRepository), code: itemFailureCode(error) });
      continue;
    }
    let buckets: string[];
    try { buckets = candidateBuckets(repository, at); }
    catch { failed.push({ id: safeItemId(searchRepository), code: "invalid_data" }); continue; }
    if (!eligible(repository, buckets)) { skipped += 1; continue; }
    const client = await dependencies.pool.connect();
    try {
      await client.query("begin");
      const created = await createProductFromRepo(client, repository, options);
      await new SnapshotStore(client).insert({
        repositoryId: created.repositoryId, capturedAt: utcHourBucket(at), granularity: "hourly",
        stars: repository.stars, forks: repository.forks, commits30d: null, prTotal: null,
        prOpen: null, prMerged: null, releasesCount: null, issuesTotal: null, issuesOpen: null,
        issuesClosed: null, candidateBuckets: buckets, candidateRuleVersion: "v1",
        collectedFields: {
          core: true,
          source_job_run_id: options.runId ?? null,
          capacity_review_id: options.reviewedCapacityOverride ? options.capacityReviewId : null,
        },
      });
      await client.query("commit");
      succeeded += 1;
    } catch (error) {
      await client.query("rollback");
      failed.push({ id: safeItemId(repository), code: itemFailureCode(error) });
    } finally { client.release(); }
  }
  return { expected: found.size, succeeded, failed, skipped };
}

function eligible(repository: GitHubRepository, buckets: string[]): boolean {
  return repository.visibility === "public" && !repository.isPrivate &&
    !repository.isFork && !repository.isArchived && !repository.isMirror &&
    Boolean(repository.description?.trim() || repository.hasReadme) && buckets.length > 0;
}

function safeItemId(repository: GitHubRepository): string {
  return Number.isSafeInteger(repository.githubRepoId) ? String(repository.githubRepoId) : "invalid_repository";
}

function itemFailureCode(error: unknown): "rate_limit" | "not_found" | "invalid_data" | "item_failed" {
  const code = error instanceof GitHubSourceError ? error.code : error instanceof Error ? error.message : "";
  if (code.includes("rate")) return "rate_limit";
  if (code.includes("404") || code.includes("not_found")) return "not_found";
  if (code.includes("invalid") || code.includes("private") || code.includes("capacity")) return "invalid_data";
  return "item_failed";
}
