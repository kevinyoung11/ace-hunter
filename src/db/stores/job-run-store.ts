import type { Queryable } from "./queryable.js";

export type JobRunStatus = "running" | "success" | "partial" | "failed";
export type TerminalJobRunStatus = Exclude<JobRunStatus, "running">;

export interface JobRunRecord {
  id: string;
  jobName: string;
  triggerType: "schedule" | "manual" | "realtime" | "user";
  parentRunId: string | null;
  scheduledFor: Date;
  dataCutoffAt: Date | null;
  parameters: unknown;
  status: JobRunStatus;
  attempt: number;
  nextAttemptAt: Date | null;
  idempotencyKey: string;
}

interface JobRunRow {
  id: string;
  job_name: string;
  trigger_type: JobRunRecord["triggerType"];
  parent_run_id: string | null;
  scheduled_for: Date;
  data_cutoff_at: Date | null;
  parameters: unknown;
  status: JobRunStatus;
  attempt: number;
  next_attempt_at: Date | null;
  idempotency_key: string;
}

const returningColumns = `id,job_name,trigger_type,parent_run_id,scheduled_for,
  data_cutoff_at,parameters,status,attempt,next_attempt_at,idempotency_key`;

function mapRow(row: JobRunRow): JobRunRecord {
  return {
    id: row.id,
    jobName: row.job_name,
    triggerType: row.trigger_type,
    parentRunId: row.parent_run_id,
    scheduledFor: row.scheduled_for,
    dataCutoffAt: row.data_cutoff_at,
    parameters: row.parameters,
    status: row.status,
    attempt: row.attempt,
    nextAttemptAt: row.next_attempt_at,
    idempotencyKey: row.idempotency_key,
  };
}

export interface JobClaimInput {
  jobName: string;
  triggerType: JobRunRecord["triggerType"];
  parentRunId?: string | null;
  scheduledFor: Date;
  dataCutoffAt?: Date | null;
  parametersJson: string;
  startedAt: Date;
  idempotencyKey: string;
}

export class JobRunStore {
  public constructor(private readonly database: Queryable) {}

  public async claim(input: JobClaimInput): Promise<{ run: JobRunRecord; inserted: boolean }> {
    const inserted = await this.database.query<JobRunRow>(
      `insert into ace_hunter.job_runs
         (job_name,trigger_type,parent_run_id,scheduled_for,data_cutoff_at,parameters,
          status,started_at,idempotency_key)
       values($1,$2,$3,$4,$5,$6::jsonb,'running',$7,$8)
       on conflict (idempotency_key) do nothing returning ${returningColumns}`,
      [input.jobName, input.triggerType, input.parentRunId ?? null, input.scheduledFor,
        input.dataCutoffAt ?? null, input.parametersJson, input.startedAt, input.idempotencyKey],
    );
    if (inserted.rowCount === 1) return { run: mapRow(inserted.rows[0]), inserted: true };
    const existing = await this.readByKey(input.idempotencyKey);
    if (!existing) throw new Error("job_run_claim_conflict_missing");
    await this.assertExactClaim(input);
    return { run: existing, inserted: false };
  }

  public async assertExactClaim(input: JobClaimInput): Promise<void> {
    const match = await this.database.query<{ matches: boolean }>(
      `select job_name=$2 and trigger_type=$3 and parent_run_id is not distinct from $4::uuid
          and scheduled_for=$5 and data_cutoff_at is not distinct from $6::timestamptz
          and parameters=$7::jsonb matches
       from ace_hunter.job_runs where idempotency_key=$1`,
      [input.idempotencyKey, input.jobName, input.triggerType, input.parentRunId ?? null,
        input.scheduledFor, input.dataCutoffAt ?? null, input.parametersJson],
    );
    if (match.rows[0]?.matches !== true) throw new Error("job_run_claim_mismatch");
  }

  public async readByKey(idempotencyKey: string): Promise<JobRunRecord | null> {
    const result = await this.database.query<JobRunRow>(
      `select ${returningColumns} from ace_hunter.job_runs where idempotency_key=$1`,
      [idempotencyKey],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  public async markFailed(input: {
    id: string; attempt: number; completedAt: Date; errorSummary: string;
    nextAttemptAt: Date | null;
  }): Promise<void> {
    const result = await this.database.query(
      `update ace_hunter.job_runs set status='failed',completed_at=$3,error_summary=$4,
          next_attempt_at=$5
       where id=$1 and status='running' and attempt=$2`,
      [input.id, input.attempt, input.completedAt, input.errorSummary, input.nextAttemptAt],
    );
    requireTransition(result.rowCount, "mark_failed");
  }

  public async prepareRetry(input: { id: string; attempt: number; startedAt: Date }): Promise<JobRunRecord> {
    const result = await this.database.query<JobRunRow>(
      `update ace_hunter.job_runs set status='running',attempt=$3,started_at=$4,
          completed_at=null,error_summary=null,next_attempt_at=null,items_expected=null,
          items_succeeded=null,items_failed=null,items_skipped=null,failed_items='[]'::jsonb
       where id=$1 and status='failed' and attempt=$2 and next_attempt_at is not null
         and next_attempt_at<=$4
       returning ${returningColumns}`,
      [input.id, input.attempt, input.attempt + 1, input.startedAt],
    );
    requireTransition(result.rowCount, "prepare_retry");
    return mapRow(result.rows[0]);
  }

  public async consumeOrphan(input: { id: string; attempt: number; startedAt: Date }): Promise<JobRunRecord> {
    const result = await this.database.query<JobRunRow>(
      `update ace_hunter.job_runs set attempt=$3,started_at=$4,completed_at=null,
          error_summary=null,next_attempt_at=null,items_expected=null,items_succeeded=null,
          items_failed=null,items_skipped=null,failed_items='[]'::jsonb
       where id=$1 and status='running' and attempt=$2 and attempt<2
       returning ${returningColumns}`,
      [input.id, input.attempt, input.attempt + 1, input.startedAt],
    );
    requireTransition(result.rowCount, "consume_orphan");
    return mapRow(result.rows[0]);
  }

  public async exhaustOrphan(input: { id: string; completedAt: Date }): Promise<JobRunRecord> {
    const result = await this.database.query<JobRunRow>(
      `update ace_hunter.job_runs set status='failed',completed_at=$2,
          error_summary='orphan_retry_exhausted',next_attempt_at=null
       where id=$1 and status='running' and attempt=2 returning ${returningColumns}`,
      [input.id, input.completedAt],
    );
    requireTransition(result.rowCount, "exhaust_orphan");
    return mapRow(result.rows[0]);
  }

  public async complete(input: {
    id: string; attempt: number; status: TerminalJobRunStatus; completedAt: Date;
    expected: number; succeeded: number; failedItems: Array<{ id: string; code: string }>;
    skipped: number;
  }): Promise<void> {
    if (!new Set<TerminalJobRunStatus>(["success", "partial", "failed"]).has(input.status)) {
      throw new Error("invalid_terminal_job_status");
    }
    const result = await this.database.query(
      `update ace_hunter.job_runs set status=$3,completed_at=$4,error_summary=null,
          next_attempt_at=null,items_expected=$5,items_succeeded=$6,items_failed=$7,
          items_skipped=$8,failed_items=$9::jsonb
       where id=$1 and status='running' and attempt=$2
         and $3 in ('success','partial','failed')`,
      [input.id, input.attempt, input.status, input.completedAt, input.expected,
        input.succeeded, input.failedItems.length, input.skipped, JSON.stringify(input.failedItems)],
    );
    requireTransition(result.rowCount, "complete");
  }
}

function requireTransition(rowCount: number | null, operation: string): void {
  if (rowCount !== 1) throw new Error(`job_run_transition_conflict:${operation}`);
}
