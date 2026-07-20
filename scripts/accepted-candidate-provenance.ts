import type { Pool } from "pg";
import { z } from "zod";

const jobRunIdsSchema = z.array(z.string().uuid()).min(2);

export async function verifyAcceptedCandidateSnapshots(
  pool: Pick<Pool, "query">,
  startedAt: Date,
  sourceJobRunIdsInput: string[],
): Promise<void> {
  const sourceJobRunIds = jobRunIdsSchema.parse(sourceJobRunIdsInput);
  const candidateSnapshots = await pool.query<{ n: number; valid: number }>(`with latest_candidate as (
      select distinct on (repository_id)
        repository_id,candidate_rule_version,candidate_buckets
      from ace_hunter.repository_snapshots
      where collected_fields->>'core'='true'
        and collected_fields->>'source_job_run_id'=any($2::text[])
        and coalesce(nullif(collected_fields->>'observed_at','')::timestamptz,created_at) >= $1
      order by repository_id,
        coalesce(nullif(collected_fields->>'observed_at','')::timestamptz,created_at) desc,
        captured_at desc,created_at desc,id desc
    )
    select count(*)::int n,count(*) filter (where candidate_rule_version='v2'
      and candidate_buckets <@ array['age_1d_stars_10','age_3d_stars_100']::text[])::int valid
    from latest_candidate`, [startedAt, sourceJobRunIds]);
  if ((candidateSnapshots.rows[0]?.n ?? 0) < 1) throw new Error("missing_candidate_v2_snapshot");
  if (candidateSnapshots.rows[0].valid !== candidateSnapshots.rows[0].n) {
    throw new Error("invalid_candidate_v2_snapshot");
  }
}
