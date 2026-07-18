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
         stars=excluded.stars,forks=excluded.forks,commits_30d=excluded.commits_30d,
         pr_total=excluded.pr_total,pr_open=excluded.pr_open,pr_merged=excluded.pr_merged,
         releases_count=excluded.releases_count,latest_release_at=excluded.latest_release_at,
         latest_release_tag=excluded.latest_release_tag,issues_total=excluded.issues_total,
         issues_open=excluded.issues_open,issues_closed=excluded.issues_closed,
         aux_metrics_captured_at=excluded.aux_metrics_captured_at,
         candidate_buckets=excluded.candidate_buckets,
         candidate_rule_version=excluded.candidate_rule_version,
         collected_fields=excluded.collected_fields
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
