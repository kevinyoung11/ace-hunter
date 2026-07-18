import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { redact } from "../core/logger.js";
import {
  JobRunStore,
  type JobRunRecord,
  type JobRunStatus,
} from "../db/stores/job-run-store.js";
import { canonicalJobParameters, jobIdempotencyKey, retryDelayMs } from "./retry-policy.js";

export type JobTriggerType = "schedule" | "manual" | "realtime" | "user";

export interface JobInput {
  name: string;
  triggerType: JobTriggerType;
  scheduledFor: Date;
  parameters: Record<string, unknown>;
  parentRunId?: string;
  dataCutoffAt?: Date;
}

export interface JobContext {
  runId: string;
  attempt: number;
  scheduledFor: Date;
  dataCutoffAt?: Date;
}

export interface JobResult {
  expected: number;
  succeeded: number;
  failed: Array<{ id: string; code: string }>;
  skipped: number;
}

export interface JobRunOutcome {
  runId: string;
  executed: boolean;
  status: JobRunStatus;
  attempt: number;
}

export class JobError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "JobError";
  }
}

export interface JobRunnerOptions {
  clock?: Clock;
  loadedSecrets?: readonly string[];
}

const resultSchema = z.object({
  expected: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  succeeded: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  failed: z.array(z.object({ id: z.string(), code: z.string() })).max(1_000),
  skipped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const allowedJobErrorCodes = new Set([
  "rate_limit",
  "source_unavailable",
  "network_error",
  "timeout",
  "validation_error",
  "authentication_error",
]);
const neverRetryCodes = new Set(["validation_error", "authentication_error"]);
const allowedItemErrorCodes = new Set([
  "rate_limit",
  "source_unavailable",
  "not_found",
  "invalid_data",
  "duplicate",
  "item_failed",
]);
const sensitiveKey = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class InvalidJobResultError extends Error {}

/**
 * A durable, at-least-once runner. A process crash after the handler's external
 * effect but before completion persistence can execute an orphaned running row again.
 */
export class JobRunner {
  private readonly clock: Clock;
  private readonly loadedSecrets: readonly string[];

  public constructor(private readonly pool: Pool, options: JobRunnerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.loadedSecrets = options.loadedSecrets ?? [];
  }

  public async run(
    input: JobInput,
    handler: (context: JobContext) => Promise<JobResult>,
  ): Promise<JobRunOutcome> {
    const validated = validateInput(input, this.loadedSecrets);
    const key = jobIdempotencyKey(validated.name, validated.scheduledFor, validated.parameters);
    const client = await this.pool.connect();
    let lockHeld = false;
    let destroyConnection = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1,0)) acquired",
        [key],
      );
      lockHeld = lock.rows[0]?.acquired === true;
      if (!lockHeld) return await this.liveDuplicateOutcome(key);

      const store = new JobRunStore(client);
      const claim = await store.claim({
        jobName: validated.name,
        triggerType: validated.triggerType,
        parentRunId: validated.parentRunId,
        scheduledFor: validated.scheduledFor,
        dataCutoffAt: validated.dataCutoffAt,
        parametersJson: validated.parametersJson,
        startedAt: this.validNow(),
        idempotencyKey: key,
      });
      if (!claim.inserted && claim.run.status !== "running") {
        return outcome(claim.run, false);
      }
      return await this.executeAttempts(store, claim.run, validated, handler);
    } catch (error) {
      if (isConnectionError(error)) destroyConnection = true;
      throw error;
    } finally {
      if (lockHeld) {
        try {
          const unlocked = await client.query<{ released: boolean }>(
            "select pg_advisory_unlock(hashtextextended($1,0)) released",
            [key],
          );
          if (unlocked.rows[0]?.released !== true) destroyConnection = true;
        } catch {
          destroyConnection = true;
        }
      }
      releaseClient(client, destroyConnection);
    }
  }

  public async runWithRetry(
    input: JobInput,
    handler: (context: JobContext) => Promise<JobResult>,
  ): Promise<JobRunOutcome> {
    return this.run(input, handler);
  }

  private async executeAttempts(
    store: JobRunStore,
    initial: JobRunRecord,
    input: ValidatedJobInput,
    handler: (context: JobContext) => Promise<JobResult>,
  ): Promise<JobRunOutcome> {
    let attempt = initial.attempt;
    for (;;) {
      try {
        const rawResult = await handler({
          runId: initial.id,
          attempt,
          scheduledFor: new Date(input.scheduledFor),
          ...(input.dataCutoffAt ? { dataCutoffAt: new Date(input.dataCutoffAt) } : {}),
        });
        const result = validateResult(rawResult, this.loadedSecrets);
        const status: JobRunStatus = result.failed.length === 0
          ? "success"
          : result.succeeded > 0
            ? "partial"
            : "failed";
        await store.complete({
          id: initial.id,
          attempt,
          status,
          completedAt: this.validNow(),
          expected: result.expected,
          succeeded: result.succeeded,
          failedItems: result.failed,
          skipped: result.skipped,
        });
        return { runId: initial.id, executed: true, status, attempt };
      } catch (error) {
        const failure = classifyFailure(error, this.loadedSecrets);
        await store.markFailed({
          id: initial.id,
          attempt,
          completedAt: this.validNow(),
          errorSummary: failure.summary,
        });
        const nextAttempt = attempt + 1;
        const delay = failure.retryable ? retryDelayMs(nextAttempt) : null;
        if (delay === null) throw new Error(`job failed (${failure.code})`);
        await this.clock.sleep(delay);
        await store.prepareRetry({ id: initial.id, attempt, startedAt: this.validNow() });
        attempt = nextAttempt;
      }
    }
  }

  private async liveDuplicateOutcome(key: string): Promise<JobRunOutcome> {
    const store = new JobRunStore(this.pool);
    for (let index = 0; index < 200; index += 1) {
      const existing = await store.readByKey(key);
      if (existing) return outcome(existing, false);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("job duplicate claim unavailable");
  }

  private validNow(): Date {
    const value = this.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("Invalid clock value");
    }
    return new Date(value);
  }
}

interface ValidatedJobInput extends JobInput {
  parametersJson: string;
}

function validateInput(input: JobInput, loadedSecrets: readonly string[]): ValidatedJobInput {
  try {
    if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(input.name)) throw new Error("job name");
    if (!["schedule", "manual", "realtime", "user"].includes(input.triggerType)) {
      throw new Error("trigger type");
    }
    requireDate(input.scheduledFor);
    if (input.dataCutoffAt) requireDate(input.dataCutoffAt);
    if (input.parentRunId && !uuid.test(input.parentRunId)) throw new Error("parent run id");
    rejectSensitiveKeys(input.parameters);
    const parametersJson = canonicalJobParameters(input.parameters);
    if (redact(parametersJson, loadedSecrets) !== parametersJson) throw new Error("secret value");
    return { ...input, parametersJson };
  } catch {
    throw new Error("invalid_job_input");
  }
}

function requireDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date");
}

function rejectSensitiveKeys(value: unknown): void {
  if (typeof value === "string") {
    if (value.length > 2_048 || hasControlCharacters(value)) {
      throw new Error("unsafe parameter string");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) rejectSensitiveKeys(child);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key.length === 0 || key.length > 128 || hasControlCharacters(key)) {
        throw new Error("unsafe parameter key");
      }
      if (sensitiveKey.test(key)) throw new Error("sensitive parameter key");
      rejectSensitiveKeys(child);
    }
  }
}

function validateResult(value: unknown, loadedSecrets: readonly string[]): JobResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new InvalidJobResultError();
  const failed: Array<{ id: string; code: string }> = [];
  const seen = new Set<string>();
  for (const item of parsed.data.failed) {
    const id = cleanText(redact(item.id, loadedSecrets), 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    failed.push({ id, code: allowedItemErrorCodes.has(item.code) ? item.code : "item_failed" });
  }
  if (parsed.data.expected !== parsed.data.succeeded + failed.length + parsed.data.skipped) {
    throw new InvalidJobResultError();
  }
  return { ...parsed.data, failed };
}

function classifyFailure(
  error: unknown,
  loadedSecrets: readonly string[],
): { code: string; retryable: boolean; summary: string } {
  if (error instanceof InvalidJobResultError) {
    return { code: "invalid_job_result", retryable: false, summary: "invalid_job_result" };
  }
  if (!(error instanceof JobError) || !allowedJobErrorCodes.has(error.code)) {
    return { code: "unexpected_job_error", retryable: false, summary: "unexpected_job_error" };
  }
  const message = cleanText(redact(error.safeMessage, loadedSecrets), 512);
  return {
    code: error.code,
    retryable: error.retryable && !neverRetryCodes.has(error.code),
    summary: message ? `${error.code}: ${message}` : error.code,
  };
}

function cleanText(value: string, maxLength: number): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && (code < 127 || code > 159);
    })
    .join("")
    .trim()
    .slice(0, maxLength);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function outcome(run: JobRunRecord, executed: boolean): JobRunOutcome {
  return { runId: run.id, executed, status: run.status, attempt: run.attempt };
}

function isConnectionError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    /^(?:08|57P01|ECONN)/.test((error as { code: string }).code));
}

function releaseClient(client: PoolClient, destroy: boolean): void {
  try {
    client.release(destroy);
  } catch {
    // A failed release has already made this connection unusable.
  }
}
