import type { Queryable } from "./queryable.js";

export class JobRunStore {
  public constructor(private readonly pool: Queryable) {}

  public async create(input: {
    jobName: string;
    triggerType: "schedule" | "manual" | "realtime" | "user";
    parentRunId?: string | null;
    scheduledFor: Date;
    parameters?: Record<string, unknown>;
    status: "running" | "success" | "partial" | "failed";
    startedAt: Date;
    idempotencyKey: string;
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `insert into ace_hunter.job_runs
         (job_name,trigger_type,parent_run_id,scheduled_for,parameters,status,
          started_at,idempotency_key)
       values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       on conflict (idempotency_key) do update set idempotency_key=excluded.idempotency_key
       returning id`,
      [
        input.jobName,
        input.triggerType,
        input.parentRunId ?? null,
        input.scheduledFor,
        JSON.stringify(input.parameters ?? {}),
        input.status,
        input.startedAt,
        input.idempotencyKey,
      ],
    );
    return result.rows[0].id;
  }
}
