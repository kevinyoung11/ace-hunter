import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "dotenv";
import { Pool } from "pg";
import { z } from "zod";
import { loadRuntimeConfig } from "../src/config/load-config.js";
import { verifyAcceptedCandidateSnapshots } from "./accepted-candidate-provenance.js";
import { verifyAcceptedSignalOutput } from "./accepted-trending-output.js";

const execFile = promisify(execFileCallback);
const runSchema = z.array(z.object({
  workflow: z.string().regex(/^[a-z0-9-]+\.yml$/u),
  databaseId: z.number().int().positive(),
  runAttempt: z.number().int().positive(),
}).strict());
const startedAt = requiredDate("ACCEPTANCE_STARTED_AT");
const kickstartBoundary = requiredDate("KICKSTART_BOUNDARY");
const runsPath = requiredAbsolute("ACCEPTANCE_RUN_IDS_FILE");
const smokeDir = requiredAbsolute("SIGNAL_SMOKE_DIR");
const mainSha = required("MAIN_SHA", /^[a-f0-9]{40}$/u);
const expectedRuns = runSchema.parse(JSON.parse(await readFile(runsPath, "utf8")));
const pool = new Pool({ connectionString: loadRuntimeConfig(process.env).runtimeDatabaseUrl });

try {
  const jobs = await pool.query<{
    id: string; job_name: string; parameters: Record<string, unknown>;
  }>(`select id,job_name,parameters from ace_hunter.job_runs
      where scheduled_for >= $1 and status in ('success','partial')`, [startedAt]);
  const requiredJobs = [
    ["discover_github_candidates", "discover.yml"],
    ["collect_github_trending", "trending.yml"],
    ["refresh_repo_metrics", "refresh-metrics.yml"],
    ["collect_x_posts", "collect-x.yml"],
    ["analyze_x_posts", "collect-x.yml"],
    ["collect_x_comments", "collect-x.yml"],
    ["generate_report", "daily-report.yml"],
    ["retention", "retention.yml"],
    ["evaluate_success", "evaluate-success.yml"],
  ] as const;
  const belongs = (row: { parameters: Record<string, unknown> }, workflow: string) => {
    const watched = expectedRuns.find((item) => item.workflow === workflow);
    return watched !== undefined && row.parameters.orchestrator_workflow === workflow &&
      row.parameters.orchestrator_run_id === String(watched.databaseId) &&
      row.parameters.orchestrator_run_attempt === String(watched.runAttempt);
  };
  for (const [name, workflow] of requiredJobs) {
    if (!jobs.rows.some((row) => row.job_name === name && belongs(row, workflow))) {
      throw new Error(`missing_acceptance_job:${name}`);
    }
  }
  const periods = [...new Set(jobs.rows.filter((row) =>
    row.job_name === "collect_github_trending" && belongs(row, "trending.yml"))
    .map((row) => row.parameters.period))].sort();
  if (JSON.stringify(periods) !== JSON.stringify(["daily", "monthly", "weekly"])) {
    throw new Error("missing_trending_period");
  }
  const candidateSourceJobIds = jobs.rows.filter((row) =>
    (row.job_name === "discover_github_candidates" && belongs(row, "discover.yml")) ||
    (row.job_name === "refresh_repo_metrics" && belongs(row, "refresh-metrics.yml")))
    .map((row) => row.id);
  await verifyAcceptedCandidateSnapshots(pool, startedAt, candidateSourceJobIds);
  const trendingRun = expectedRuns.find((item) => item.workflow === "trending.yml");
  if (trendingRun === undefined) throw new Error("missing_complete_trending_batch");
  const completeTrending = await pool.query<{ period: string; captured_at: Date; job_run_id: string }>(`with candidate_batches as (
      select trending.period,trending.captured_at,
        min(trending.job_run_id::text)::uuid job_run_id,count(*)::int row_count
      from ace_hunter.github_trending_snapshots trending
      where trending.language='all'
        and trending.period=any(array['daily','weekly','monthly']::text[])
      group by trending.period,trending.captured_at
      having count(trending.job_run_id)=count(*)
        and count(distinct trending.job_run_id)=1
        and bool_and(trending.collection_status='success')
    )
    select distinct candidate.period,candidate.captured_at,candidate.job_run_id
    from candidate_batches candidate
    join ace_hunter.job_runs run on run.id=candidate.job_run_id
    where run.job_name='collect_github_trending'
      and run.status='success' and run.completed_at is not null
      and run.completed_at >= $1
      and run.items_failed=0 and run.items_succeeded=candidate.row_count
      and run.parameters->>'orchestrator_workflow'='trending.yml'
      and run.parameters->>'orchestrator_run_id'=$2
      and run.parameters->>'orchestrator_run_attempt'=$3
    order by candidate.period`, [
    startedAt, String(trendingRun.databaseId), String(trendingRun.runAttempt),
  ]);
  if (JSON.stringify(completeTrending.rows.map((row) => row.period)) !==
      JSON.stringify(["daily", "monthly", "weekly"])) {
    throw new Error("missing_complete_trending_batch");
  }
  await verifyAcceptedSignalOutput({
    pool,
    smokeDir,
    expectedSmokeDir: join(dirname(runsPath), "release-rollback", "continuation-smoke"),
    batches: completeTrending.rows.map((row) => ({
      period: row.period, capturedAt: row.captured_at, jobRunId: row.job_run_id,
    })),
  });
  const outputs = await pool.query<{ output_type: string }>(`select output_type from ace_hunter.analysis_outputs
    where (output_type='daily_report' and completed_at >= $1)
       or (output_type='realtime_observation' and created_at >= $1)`, [startedAt]);
  if (!outputs.rows.some((row) => row.output_type === "daily_report")) throw new Error("daily_report_not_rerun");
  if (!outputs.rows.some((row) => row.output_type === "realtime_observation")) throw new Error("missing_realtime_observation");
  const evaluationJob = jobs.rows.find((row) => row.job_name === "evaluate_success" && belongs(row, "evaluate-success.yml"));
  const evaluations = await pool.query<{ value: Record<string, unknown> }>(`select structured_content->'evaluation' value
    from ace_hunter.analysis_outputs where output_type='daily_report'
      and (structured_content->'evaluation'->>'evaluated_at')::timestamptz >= $1`, [startedAt]);
  if (!evaluationJob || !evaluations.rows.some((row) =>
    ["evaluated", "not_enough_history"].includes(String(row.value.status)) &&
      row.value.source_job_run_id === evaluationJob.id)) throw new Error("missing_current_evaluation_status");

  const kicked = await pool.query<{ scheduler_run_id: string }>(`select parameters->>'scheduler_run_id' scheduler_run_id
    from ace_hunter.job_runs where created_at>$1 and parent_run_id is null and job_name='collect_x_posts'
      and parameters->>'scheduler'='launchd' order by created_at limit 1`, [kickstartBoundary]);
  if (kicked.rowCount !== 1 || !kicked.rows[0].scheduler_run_id) throw new Error("kickstarted_x_pipeline_missing");
  const scheduled = await pool.query<{
    job_name: string; parameters: Record<string, unknown>; scheduled_for: Date;
    started_at: Date; completed_at: Date; status: string;
  }>(`select job_name,parameters,scheduled_for,started_at,completed_at,status from ace_hunter.job_runs
      where parent_run_id is null and parameters->>'scheduler'='launchd' and parameters->>'scheduler_run_id'=$1`,
  [kicked.rows[0].scheduler_run_id]);
  for (const name of ["collect_x_posts", "analyze_x_posts", "collect_x_comments"]) {
    if (!scheduled.rows.some((row) => row.job_name === name && ["success", "partial"].includes(row.status))) {
      throw new Error("durable_x_pipeline_not_attributable");
    }
  }
  const comments = scheduled.rows.find((row) => row.job_name === "collect_x_comments");
  const productIds = z.array(z.string().uuid()).min(1).parse(comments?.parameters.product_ids);
  const rootIds = z.array(z.string().min(1)).min(1).parse(comments?.parameters.root_post_ids);
  const analyzed = await pool.query<{ n: number }>(`select count(*)::int n from ace_hunter.product_x_posts
    where post_type='comment' and product_id=any($1::uuid[]) and root_post_id=any($2::text[])
      and metrics_updated_at between $3 and $4 and analyzed_at is not null
      and relevance_score is not null and sentiment is not null`,
  [productIds, rootIds, comments?.scheduled_for, comments?.completed_at]);
  if ((analyzed.rows[0]?.n ?? 0) < 1) throw new Error("durable_x_comments_not_analyzed");

  const schedulerPath = `${process.env.HOME}/Library/Application Support/AceHunter/scheduler.conf`;
  const scheduler = parse(await readFile(schedulerPath, "utf8"));
  for (const key of ["NODE_PATH", "TWITTER_CLI_PATH", "RELEASE_ROOT"] as const) {
    if (!scheduler[key]?.startsWith("/")) throw new Error("scheduler_config_invalid");
  }
  if (!scheduler.RELEASE_ROOT.endsWith(`/releases/${mainSha}`)) throw new Error("scheduler_release_mismatch");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("posix_uid_required");
  const launchd = await execFile("/bin/launchctl", ["print", `gui/${uid}/com.kevinyoung.ace-hunter.collect-x`]);
  if (!launchd.stdout.includes(mainSha) || launchd.stdout.includes(".config/superpowers/worktrees")) {
    throw new Error("launchagent_not_bound_to_main_release");
  }
  process.stdout.write("post_merge_acceptance_passed\n");
} finally {
  await pool.end();
}

function required(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(`invalid_${name.toLowerCase()}`);
  return value;
}
function requiredAbsolute(name: string): string { return required(name, /^\/(?!\/).+/u); }
function requiredDate(name: string): Date {
  const value = new Date(required(name, /^\d{4}-\d{2}-\d{2}T/u));
  if (!Number.isFinite(value.getTime())) throw new Error(`invalid_${name.toLowerCase()}`);
  return value;
}
