import type { Queryable } from "./queryable.js";

export class AnalysisOutputStore {
  public constructor(private readonly pool: Queryable) {}

  public async upsert(input: {
    outputType: "daily_report" | "product_analysis" | "realtime_observation";
    userId?: string | null;
    productId?: string | null;
    monitorId?: string | null;
    periodStart: Date;
    periodEnd: Date;
    dataCutoffAt: Date;
    status: "running" | "complete" | "partial" | "failed";
    verdict?: string | null;
    confidence?: number | null;
    title: string;
    summary?: string | null;
    structuredContent: Record<string, unknown>;
    renderedMarkdown: string;
    analysisVersion: string;
    modelName?: string | null;
    triggerType: "schedule" | "manual" | "realtime";
    idempotencyKey?: string | null;
    sourceJobRunId?: string | null;
    startedAt: Date;
    completedAt?: Date | null;
  }): Promise<string> {
    const conflictClause = {
      daily_report: `on conflict (output_type,period_start,period_end)
        where output_type='daily_report' and user_id is null and product_id is null`,
      product_analysis: `on conflict (output_type,product_id,period_start,period_end)
        where output_type='product_analysis' and product_id is not null`,
      realtime_observation: `on conflict (output_type,product_id,idempotency_key)
        where output_type='realtime_observation' and product_id is not null
          and idempotency_key is not null`,
    }[input.outputType];
    const result = await this.pool.query<{ id: string }>(
      `insert into ace_hunter.analysis_outputs as current_output (
         output_type,user_id,product_id,monitor_id,period_start,period_end,
         data_cutoff_at,status,verdict,confidence,title,summary,structured_content,
         rendered_markdown,analysis_version,model_name,trigger_type,idempotency_key,
         source_job_run_id,started_at,completed_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,
         $19,$20,$21
       )
       ${conflictClause} do update set
         user_id=excluded.user_id,
         monitor_id=excluded.monitor_id,
         data_cutoff_at=excluded.data_cutoff_at,
         status=excluded.status,
         verdict=excluded.verdict,
         confidence=excluded.confidence,
         title=excluded.title,
         summary=excluded.summary,
         structured_content=excluded.structured_content ||
           case when current_output.structured_content ? 'evaluation'
             then jsonb_build_object(
               'evaluation',current_output.structured_content->'evaluation'
             )
             else '{}'::jsonb
           end,
         rendered_markdown=excluded.rendered_markdown,
         analysis_version=excluded.analysis_version,
         model_name=excluded.model_name,
         trigger_type=excluded.trigger_type,
         source_job_run_id=excluded.source_job_run_id,
         started_at=excluded.started_at,
         completed_at=excluded.completed_at
       returning id`,
      [
        input.outputType,
        input.userId ?? null,
        input.productId ?? null,
        input.monitorId ?? null,
        input.periodStart,
        input.periodEnd,
        input.dataCutoffAt,
        input.status,
        input.verdict ?? null,
        input.confidence ?? null,
        input.title,
        input.summary ?? null,
        JSON.stringify(input.structuredContent),
        input.renderedMarkdown,
        input.analysisVersion,
        input.modelName ?? null,
        input.triggerType,
        input.idempotencyKey ?? null,
        input.sourceJobRunId ?? null,
        input.startedAt,
        input.completedAt ?? null,
      ],
    );
    return result.rows[0].id;
  }
}
