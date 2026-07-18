import type { Queryable } from "./queryable.js";

export interface TrendingInsert {
  repositoryId: string;
  period: "daily" | "weekly" | "monthly";
  language?: string;
  capturedAt: Date;
  rank: number;
  starsInPeriod: number | null;
  sourceUrl: string;
  collectionStatus: "success" | "partial";
  jobRunId?: string | null;
}

export class TrendingStore {
  public constructor(private readonly pool: Queryable) {}

  public async insert(input: TrendingInsert): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `insert into ace_hunter.github_trending_snapshots
         (repository_id,period,language,captured_at,rank,stars_in_period,
          source_url,collection_status,job_run_id)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (period,language,captured_at,repository_id) do update set
         rank=excluded.rank,stars_in_period=excluded.stars_in_period,
         source_url=excluded.source_url,collection_status=excluded.collection_status,
         job_run_id=excluded.job_run_id
       returning id`,
      [
        input.repositoryId,
        input.period,
        input.language ?? "all",
        input.capturedAt,
        input.rank,
        input.starsInPeriod,
        input.sourceUrl,
        input.collectionStatus,
        input.jobRunId ?? null,
      ],
    );
    return result.rows[0].id;
  }

  public async replaceBatch(inputs: readonly TrendingInsert[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const first = inputs[0];
    const language = first.language ?? "all";
    if (
      inputs.some(
        (input) =>
          input.period !== first.period ||
          (input.language ?? "all") !== language ||
          input.capturedAt.getTime() !== first.capturedAt.getTime(),
      )
    ) {
      throw new Error("Trending batch must share period, language, and capturedAt");
    }
    const payload = inputs.map((input) => ({
      repository_id: input.repositoryId,
      rank: input.rank,
      stars_in_period: input.starsInPeriod,
      source_url: input.sourceUrl,
      collection_status: input.collectionStatus,
      job_run_id: input.jobRunId ?? null,
    }));
    const result = await this.pool.query<{ id: string }>(
      `with input as (
         select * from jsonb_to_recordset($1::jsonb) as row(
           repository_id uuid,rank integer,stars_in_period bigint,source_url text,
           collection_status text,job_run_id uuid
         )
       ), deleted as (
         delete from ace_hunter.github_trending_snapshots
          where period=$2 and language=$3 and captured_at=$4
          returning 1
       ), deletion_barrier as (
         select count(*) removed from deleted
       ), inserted as (
         insert into ace_hunter.github_trending_snapshots
           (repository_id,period,language,captured_at,rank,stars_in_period,
            source_url,collection_status,job_run_id)
         select input.repository_id,$2,$3,$4,input.rank,input.stars_in_period,
                input.source_url,input.collection_status,input.job_run_id
           from input cross join deletion_barrier
         returning id
       )
       select id from inserted`,
      [JSON.stringify(payload), first.period, language, first.capturedAt],
    );
    return result.rows.map((row) => row.id);
  }
}
