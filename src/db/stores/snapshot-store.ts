import type { Queryable } from "./queryable.js";

export interface SnapshotInput {
  repositoryId: string;
  capturedAt: Date;
  granularity: "hourly" | "daily" | "realtime";
  stars: number;
  forks: number | null;
  commits30d: number | null;
  prTotal: number | null;
  prOpen: number | null;
  prMerged: number | null;
  releasesCount: number | null;
  latestReleaseAt?: Date | null;
  latestReleaseTag?: string | null;
  issuesTotal: number | null;
  issuesOpen: number | null;
  issuesClosed: number | null;
  auxMetricsCapturedAt?: Date | null;
  candidateBuckets: string[];
  candidateRuleVersion?: string | null;
  collectedFields: Record<string, unknown>;
}

export interface SnapshotRecord {
  id: string;
  repositoryId: string;
  capturedAt: Date;
  granularity: SnapshotInput["granularity"];
  stars: number;
  forks: number | null;
  commits30d: number | null;
  prTotal: number | null;
  prOpen: number | null;
  prMerged: number | null;
  releasesCount: number | null;
  issuesTotal: number | null;
  issuesOpen: number | null;
  issuesClosed: number | null;
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export class SnapshotStore {
  public constructor(private readonly pool: Queryable) {}

  public async insert(input: SnapshotInput): Promise<SnapshotRecord> {
    const result = await this.pool.query<{
      id: string;
      repository_id: string;
      captured_at: Date;
      granularity: SnapshotInput["granularity"];
      stars: string | number;
      forks: string | number | null;
      commits_30d: number | null;
      pr_total: number | null;
      pr_open: number | null;
      pr_merged: number | null;
      releases_count: number | null;
      issues_total: number | null;
      issues_open: number | null;
      issues_closed: number | null;
    }>(
      `insert into ace_hunter.repository_snapshots (
         repository_id,captured_at,granularity,stars,forks,commits_30d,pr_total,
         pr_open,pr_merged,releases_count,latest_release_at,latest_release_tag,
         issues_total,issues_open,issues_closed,aux_metrics_captured_at,
         candidate_buckets,candidate_rule_version,collected_fields
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb
       )
       on conflict (repository_id,captured_at,granularity) do update set
         stars=case when repository_snapshots.collected_fields?'observed_at' and
           (not excluded.collected_fields?'observed_at' or excluded.collected_fields->>'observed_at'<repository_snapshots.collected_fields->>'observed_at')
           then repository_snapshots.stars else excluded.stars end,
         forks=case when repository_snapshots.collected_fields?'observed_at' and
           (not excluded.collected_fields?'observed_at' or excluded.collected_fields->>'observed_at'<repository_snapshots.collected_fields->>'observed_at')
           then repository_snapshots.forks else excluded.forks end,
         commits_30d=case when excluded.aux_metrics_captured_at is not null and
           (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.commits_30d else repository_snapshots.commits_30d end,
         pr_total=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.pr_total else repository_snapshots.pr_total end,
         pr_open=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.pr_open else repository_snapshots.pr_open end,
         pr_merged=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.pr_merged else repository_snapshots.pr_merged end,
         releases_count=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.releases_count else repository_snapshots.releases_count end,
         latest_release_at=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.latest_release_at else repository_snapshots.latest_release_at end,
         latest_release_tag=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.latest_release_tag else repository_snapshots.latest_release_tag end,
         issues_total=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.issues_total else repository_snapshots.issues_total end,
         issues_open=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.issues_open else repository_snapshots.issues_open end,
         issues_closed=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.issues_closed else repository_snapshots.issues_closed end,
         aux_metrics_captured_at=case when excluded.aux_metrics_captured_at is not null and (repository_snapshots.aux_metrics_captured_at is null or excluded.aux_metrics_captured_at>=repository_snapshots.aux_metrics_captured_at) then excluded.aux_metrics_captured_at else repository_snapshots.aux_metrics_captured_at end,
         candidate_buckets=case when repository_snapshots.collected_fields?'observed_at' and
           (not excluded.collected_fields?'observed_at' or excluded.collected_fields->>'observed_at'<repository_snapshots.collected_fields->>'observed_at')
           then repository_snapshots.candidate_buckets
           when excluded.candidate_rule_version is null then repository_snapshots.candidate_buckets else excluded.candidate_buckets end,
         candidate_rule_version=case when repository_snapshots.collected_fields?'observed_at' and
           (not excluded.collected_fields?'observed_at' or excluded.collected_fields->>'observed_at'<repository_snapshots.collected_fields->>'observed_at')
           then repository_snapshots.candidate_rule_version
           else coalesce(excluded.candidate_rule_version,repository_snapshots.candidate_rule_version) end,
         collected_fields=repository_snapshots.collected_fields || excluded.collected_fields ||
           case when repository_snapshots.collected_fields?'observed_at' and
             (not excluded.collected_fields?'observed_at' or excluded.collected_fields->>'observed_at'<repository_snapshots.collected_fields->>'observed_at')
           then jsonb_strip_nulls(jsonb_build_object(
             'observed_at',repository_snapshots.collected_fields->'observed_at',
             'source_job_run_id',repository_snapshots.collected_fields->'source_job_run_id'
           )) else '{}'::jsonb end ||
           case when excluded.aux_metrics_captured_at is null or repository_snapshots.aux_metrics_captured_at is not null and (
             excluded.aux_metrics_captured_at<repository_snapshots.aux_metrics_captured_at or
             excluded.aux_metrics_captured_at=repository_snapshots.aux_metrics_captured_at and excluded.collected_fields->>'aux_reused'='true')
           then jsonb_strip_nulls(jsonb_build_object(
             'aux',repository_snapshots.collected_fields->'aux',
             'aux_reused',repository_snapshots.collected_fields->'aux_reused',
             'aux_window_start',repository_snapshots.collected_fields->'aux_window_start',
             'aux_window_end',repository_snapshots.collected_fields->'aux_window_end'
           )) else '{}'::jsonb end
       returning id,repository_id,captured_at,granularity,stars,forks,commits_30d,
         pr_total,pr_open,pr_merged,releases_count,issues_total,issues_open,issues_closed`,
      [
        input.repositoryId,
        input.capturedAt,
        input.granularity,
        input.stars,
        input.forks,
        input.commits30d,
        input.prTotal,
        input.prOpen,
        input.prMerged,
        input.releasesCount,
        input.latestReleaseAt ?? null,
        input.latestReleaseTag ?? null,
        input.issuesTotal,
        input.issuesOpen,
        input.issuesClosed,
        input.auxMetricsCapturedAt ?? null,
        input.candidateBuckets,
        input.candidateRuleVersion ?? null,
        JSON.stringify(input.collectedFields),
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      repositoryId: row.repository_id,
      capturedAt: row.captured_at,
      granularity: row.granularity,
      stars: Number(row.stars),
      forks: nullableNumber(row.forks),
      commits30d: nullableNumber(row.commits_30d),
      prTotal: nullableNumber(row.pr_total),
      prOpen: nullableNumber(row.pr_open),
      prMerged: nullableNumber(row.pr_merged),
      releasesCount: nullableNumber(row.releases_count),
      issuesTotal: nullableNumber(row.issues_total),
      issuesOpen: nullableNumber(row.issues_open),
      issuesClosed: nullableNumber(row.issues_closed),
    };
  }
}
