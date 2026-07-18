import type { Queryable } from "./queryable.js";

export type JobRunStatus = "running" | "success" | "partial" | "failed";

export interface JobRunRecord {
  id: string;
  status: JobRunStatus;
  attempt: number;
  idempotencyKey: string;
}

interface JobRunRow {
  id: string;
  status: JobRunStatus;
  attempt: number;
  idempotency_key: string;
}

function mapRow(row: JobRunRow): JobRunRecord {
  return { id: row.id, status: row.status, attempt: row.attempt, idempotencyKey: row.idempotency_key };
}

export class JobRunStore {
  public constructor(private readonly database: Queryable) {}

  public async claim(input: {
    jobName: string;
    triggerType: "schedule" | "manual" | "realtime" | "user";
    parentRunId?: string | null;
    scheduledFor: Date;
    dataCutoffAt?: Date | null;
    parametersJson: string;
    startedAt: Date;
    idempotencyKey: string;
  }): Promise<{ run: JobRunRecord; inserted: boolean }> {
    const inserted = await this.database.query<JobRunRow>(
      `insert into ace_hunter.job_runs
         (job_name,trigger_type,parent_run_id,scheduled_for,data_cutoff_at,parameters,
          status,started_at,idempotency_key)
       values($1,$2,$3,$4,$5,$6::jsonb,'running',$7,$8)
       on conflict (idempotency_key) do nothing
       returning id,status,attempt,idempotency_key`,
      [input.jobName, input.triggerType, input.parentRunId ?? null, input.scheduledFor,
        input.dataCutoffAt ?? null, input.parametersJson, input.startedAt, input.idempotencyKey],
    );
    if (inserted.rowCount === 1) return { run: mapRow(inserted.rows[0]), inserted: true };
    const existing = await this.readByKey(input.idempotencyKey);
    if (!existing) throw new Error("job_run_claim_conflict_missing");
    return { run: existing, inserted: false };
  }

  public async readByKey(idempotencyKey: string): Promise<JobRunRecord | null> {
    const result = await this.database.query<JobRunRow>(
      `select id,status,attempt,idempotency_key from ace_hunter.job_runs
       where idempotency_key=$1`,
      [idempotencyKey],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  public async markFailed(input: {
    id: string; attempt: number; completedAt: Date; errorSummary: string;
  }): Promise<void> {
    const result = await this.database.query(
      `update ace_hunter.job_runs set status='failed',completed_at=$3,error_summary=$4
       where id=$1 and status='running' and attempt=$2`,
      [input.id, input.attempt, input.completedAt, input.errorSummary],
    );
    requireTransition(result.rowCount, "mark_failed");
  }

  public async prepareRetry(input: { id: string; attempt: number; startedAt: Date }): Promise<void> {
    const result = await this.database.query(
      `update ace_hunter.job_runs set status='running',attempt=$3,started_at=$4,
          completed_at=null,error_summary=null,items_expected=null,items_succeeded=null,
          items_failed=null,items_skipped=null,failed_items='[]'::jsonb
       where id=$1 and status='failed' and attempt=$2`,
      [input.id, input.attempt, input.attempt + 1, input.startedAt],
    );
    requireTransition(result.rowCount, "prepare_retry");
  }

  public async complete(input: {
    id: string; attempt: number; status: JobRunStatus; completedAt: Date;
    expected: number; succeeded: number; failedItems: Array<{ id: string; code: string }>;
    skipped: number;
  }): Promise<void> {
    const result = await this.database.query(
      `update ace_hunter.job_runs set status=$3,completed_at=$4,error_summary=null,
          items_expected=$5,items_succeeded=$6,items_failed=$7,items_skipped=$8,
          failed_items=$9::jsonb
       where id=$1 and status='running' and attempt=$2`,
      [input.id, input.attempt, input.status, input.completedAt, input.expected,
        input.succeeded, input.failedItems.length, input.skipped, JSON.stringify(input.failedItems)],
    );
    requireTransition(result.rowCount, "complete");
  }
}

function requireTransition(rowCount: number | null, operation: string): void {
  if (rowCount !== 1) throw new Error(`job_run_transition_conflict:${operation}`);
}
