import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { redact } from "../core/logger.js";
import {
  JobRunStore,
  type JobRunRecord,
  type JobRunStatus,
  type TerminalJobRunStatus,
} from "../db/stores/job-run-store.js";
import {
  canonicalJobParameters,
  jobIdempotencyKeyFromCanonical,
  retryDelayMs,
} from "./retry-policy.js";

export type JobTriggerType = "schedule" | "manual" | "realtime" | "user";

export interface JobInput {
  name: string;
  triggerType: JobTriggerType;
  scheduledFor: Date;
  parameters: Record<string, unknown>;
  parentRunId?: string;
  dataCutoffAt?: Date;
  commandId?: string;
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
  lockPool: Pool;
  loadedSecrets: readonly string[];
  clock?: Clock;
  duplicateDeadlineMs?: number;
  duplicatePollMs?: number;
}

const postgresIntMax = 2_147_483_647;
const resultSchema = z.object({
  expected: z.number().int().nonnegative().max(postgresIntMax),
  succeeded: z.number().int().nonnegative().max(postgresIntMax),
  failed: z.array(z.object({ id: z.string().max(512), code: z.string().max(128) })).max(1_000),
  skipped: z.number().int().nonnegative().max(postgresIntMax),
}).strict();

const allowedJobErrorCodes = new Set([
  "rate_limit",
  "source_unavailable",
  "network_error",
  "timeout",
  "validation_error",
  "authentication_error",
  "capacity_review_required",
  "capacity_hard_limit",
]);
const neverRetryCodes = new Set(["validation_error", "authentication_error", "capacity_review_required", "capacity_hard_limit"]);
const allowedItemErrorCodes = new Set([
  "rate_limit",
  "source_unavailable",
  "not_found",
  "invalid_data",
  "aux_budget_exhausted",
  "duplicate",
  "item_failed",
]);
const sensitiveKey = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|database[_-]?url|dsn|private[_-]?key|session|connection[_-]?string)/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class InvalidJobResultError extends Error {}

/**
 * A durable, at-least-once runner. A process crash after the handler's external
 * effect but before completion persistence can execute an orphaned running row again.
 */
export class JobRunner {
  private readonly clock: Clock;
  private readonly loadedSecrets: readonly string[];
  private readonly lockPool: Pool;
  private readonly duplicateDeadlineMs: number;
  private readonly duplicatePollMs: number;

  public constructor(private readonly pool: Pool, options: JobRunnerOptions) {
    if (
      !options || options.lockPool === pool || !Array.isArray(options.loadedSecrets) ||
      poolTargetFingerprint(options.lockPool) !== poolTargetFingerprint(pool)
    ) {
      throw new Error("invalid_job_runner_options");
    }
    this.lockPool = options.lockPool;
    this.clock = options.clock ?? systemClock;
    this.loadedSecrets = [...options.loadedSecrets];
    this.duplicateDeadlineMs = options.duplicateDeadlineMs ?? 1_000;
    this.duplicatePollMs = options.duplicatePollMs ?? 5;
  }

  public async run(
    input: JobInput,
    handler: (context: JobContext) => Promise<JobResult>,
  ): Promise<JobRunOutcome> {
    const validated = validateInput(input, this.loadedSecrets);
    const key = jobIdempotencyKeyFromCanonical(
      validated.name,
      validated.scheduledFor,
      validated.parametersJson,
    );
    let client: PoolClient;
    try {
      client = await this.lockPool.connect();
    } catch {
      throw new Error("job runner unavailable");
    }
    let lockHeld = false;
    let destroyConnection = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1,0)) acquired",
        [key],
      );
      lockHeld = lock.rows[0]?.acquired === true;
      const store = new JobRunStore(client);
      const claimInput = {
        jobName: validated.name,
        triggerType: validated.triggerType,
        parentRunId: validated.parentRunId,
        scheduledFor: validated.scheduledFor,
        dataCutoffAt: validated.dataCutoffAt,
        parametersJson: validated.parametersJson,
        startedAt: this.validNow(),
        idempotencyKey: key,
      };
      if (!lockHeld) return await this.liveDuplicateOutcome(client, claimInput);
      const claim = await store.claim(claimInput);
      if (!claim.inserted) {
        if (claim.run.status === "failed" && claim.run.nextAttemptAt && claim.run.attempt < 2) {
          const remaining = Math.max(0, claim.run.nextAttemptAt.getTime() - this.validNow().getTime());
          if (remaining > 0) await this.safeSleep(remaining);
          const retryStartedAt = this.validNow();
          if (retryStartedAt.getTime() < claim.run.nextAttemptAt.getTime()) {
            throw new Error("job retry interrupted");
          }
          const resumed = await store.prepareRetry({
            id: claim.run.id,
            attempt: claim.run.attempt,
            startedAt: retryStartedAt,
          });
          return await this.executeAttempts(store, resumed, validated, handler);
        }
        if (claim.run.status !== "running") return outcome(claim.run, false);
        if (claim.run.attempt >= 2) {
          return outcome(await store.exhaustOrphan({
            id: claim.run.id,
            completedAt: this.validNow(),
          }), false);
        }
        const resumed = await store.consumeOrphan({
          id: claim.run.id,
          attempt: claim.run.attempt,
          startedAt: this.validNow(),
        });
        return await this.executeAttempts(store, resumed, validated, handler);
      }
      return await this.executeAttempts(store, claim.run, validated, handler);
    } catch (error) {
      if (isConnectionError(error)) destroyConnection = true;
      throw sanitizeRunnerError(error);
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
        const status: TerminalJobRunStatus = result.failed.length === 0
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
        const nextAttempt = attempt + 1;
        const delay = failure.retryable ? retryDelayMs(nextAttempt) : null;
        const completedAt = this.validNow();
        await store.markFailed({
          id: initial.id,
          attempt,
          completedAt,
          errorSummary: failure.summary,
          nextAttemptAt: delay === null ? null : new Date(completedAt.getTime() + delay),
        });
        if (delay === null) throw new Error(`job failed (${failure.code})`);
        await this.safeSleep(delay);
        const retryStartedAt = this.validNow();
        const retryDeadline = completedAt.getTime() + delay;
        if (retryStartedAt.getTime() < retryDeadline) throw new Error("job retry interrupted");
        await store.prepareRetry({ id: initial.id, attempt, startedAt: retryStartedAt });
        attempt = nextAttempt;
      }
    }
  }

  private async liveDuplicateOutcome(
    client: PoolClient,
    claimInput: Parameters<JobRunStore["assertExactClaim"]>[0],
  ): Promise<JobRunOutcome> {
    const store = new JobRunStore(client);
    const deadline = this.validNow().getTime() + this.duplicateDeadlineMs;
    for (let index = 0; index < 1_000; index += 1) {
      const existing = await store.readByKey(claimInput.idempotencyKey);
      if (existing) {
        await store.assertExactClaim(claimInput);
        return outcome(existing, false);
      }
      if (this.validNow().getTime() >= deadline) break;
      await this.clock.sleep(this.duplicatePollMs);
    }
    throw new Error("job duplicate claim unavailable");
  }

  private async safeSleep(milliseconds: number): Promise<void> {
    try {
      await this.clock.sleep(milliseconds);
    } catch {
      throw new Error("job retry interrupted");
    }
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
    const parametersJson = canonicalJobParameters(input.parameters, {}, {
      validateString: (value, kind) => validateParameterString(value, kind, loadedSecrets),
    });
    return {
      ...input,
      scheduledFor: new Date(input.scheduledFor),
      ...(input.dataCutoffAt ? { dataCutoffAt: new Date(input.dataCutoffAt) } : {}),
      parametersJson,
    };
  } catch {
    throw new Error("invalid_job_input");
  }
}

function requireDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date");
}

function validateParameterString(
  value: string,
  kind: "key" | "value",
  loadedSecrets: readonly string[],
): void {
  if (kind === "key" && (value.length === 0 || sensitiveKey.test(value))) {
    throw new Error("sensitive parameter key");
  }
  if (
    loadedSecrets.some((secret) => secret.length > 0 && value.includes(secret)) ||
    redact(value, loadedSecrets) !== value
  ) throw new Error("sensitive parameter string");
}

function validateResult(value: unknown, loadedSecrets: readonly string[]): JobResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new InvalidJobResultError();
  const failed: Array<{ id: string; code: string }> = [];
  const seen = new Set<string>();
  for (const item of parsed.data.failed) {
    const id = cleanText(redact(item.id, loadedSecrets), 128);
    if (!id || seen.has(id)) throw new InvalidJobResultError();
    seen.add(id);
    failed.push({ id, code: allowedItemErrorCodes.has(item.code) ? item.code : "item_failed" });
  }
  const accounted = parsed.data.succeeded + failed.length + parsed.data.skipped;
  if (!Number.isSafeInteger(accounted) || accounted > postgresIntMax || parsed.data.expected !== accounted) {
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
  if (
    !(error instanceof JobError) || typeof error.code !== "string" ||
    typeof error.retryable !== "boolean" || typeof error.safeMessage !== "string" ||
    !allowedJobErrorCodes.has(error.code)
  ) {
    return { code: "unexpected_job_error", retryable: false, summary: "unexpected_job_error" };
  }
  const rawMessageWithinBounds = error.safeMessage.length <= 2_048 &&
    Buffer.byteLength(error.safeMessage, "utf8") <= 2_048;
  const message = rawMessageWithinBounds
    ? cleanText(redact(error.safeMessage, loadedSecrets), 512)
    : "";
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

function sanitizeRunnerError(error: unknown): Error {
  if (error instanceof Error && (
    /^job failed \([a-z_]+\)$/.test(error.message) ||
    error.message === "job_run_claim_mismatch" ||
    error.message === "job duplicate claim unavailable" ||
    error.message === "job retry interrupted"
  )) return new Error(error.message);
  return new Error("job runner unavailable");
}

function poolTargetFingerprint(pool: Pool): string {
  const options = pool.options as unknown as Record<string, unknown>;
  const target = {
    connectionString: scalarPoolOption(options.connectionString),
    host: scalarPoolOption(options.host),
    port: scalarPoolOption(options.port),
    database: scalarPoolOption(options.database),
    user: scalarPoolOption(options.user),
    password: scalarPoolOption(options.password),
    ssl: safePoolSslOption(options.ssl),
  };
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

function scalarPoolOption(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new Error("invalid_job_runner_options");
}

function safePoolSslOption(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? createHash("sha256").update(serialized).digest("hex")
      : "unserializable";
  } catch {
    throw new Error("invalid_job_runner_options");
  }
}
