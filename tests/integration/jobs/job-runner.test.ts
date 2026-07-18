import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { JobError, JobRunner, type JobInput } from "../../../src/jobs/job-runner.js";
import { JobRunStore } from "../../../src/db/stores/job-run-store.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const config = parseTestDatabaseConfig(process.env);
let adminPool: Pool;
let runtimePool: Pool;
let lockPool: Pool;
const baseInput: JobInput = {
  name: "collect_x_posts",
  triggerType: "schedule",
  scheduledFor: new Date("2026-07-19T00:00:00Z"),
  parameters: { z: 2, a: 1 },
  dataCutoffAt: new Date("2026-07-18T23:00:00Z"),
};

beforeAll(async () => {
  ({ adminPool, runtimePool } = await createVerifiedTestPools({
    ACE_TEST_ADMIN_DATABASE_URL: config.adminDatabaseUrl,
    ACE_TEST_MIGRATION_DATABASE_URL: config.migrationDatabaseUrl,
    ACE_TEST_RUNTIME_DATABASE_URL: config.runtimeDatabaseUrl,
  }));
  lockPool = new Pool({ connectionString: config.runtimeDatabaseUrl, max: 4 });
});
beforeEach(async () => adminPool.query("truncate ace_hunter.job_runs cascade"));
afterAll(async () => Promise.all([adminPool.end(), runtimePool.end(), lockPool.end()]));

const runner = (options: Partial<ConstructorParameters<typeof JobRunner>[1]> = {}) =>
  new JobRunner(runtimePool, { lockPool, loadedSecrets: [], ...options });

describe("JobRunner", () => {
  it("lets only one of twenty live duplicates execute", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.fn(async () => {
      await barrier;
      return { expected: 1, succeeded: 1, failed: [], skipped: 0 };
    });
    const jobRunner = runner();
    const first = jobRunner.run(baseInput, handler);
    while (handler.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const duplicates = Array.from({ length: 19 }, () => jobRunner.run(baseInput, handler));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const results = await Promise.all([first, ...duplicates]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => result.runId)).size).toBe(1);
    expect(results.filter((result) => result.executed)).toHaveLength(1);
  });

  it("allows different keys to execute concurrently", async () => {
    let active = 0;
    let peak = 0;
    const handler = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
    };
    const jobRunner = runner();
    await Promise.all([
      jobRunner.run({ ...baseInput, parameters: { key: 1 } }, handler),
      jobRunner.run({ ...baseInput, parameters: { key: 2 } }, handler),
    ]);
    expect(peak).toBe(2);
  });

  it("persists each typed failed attempt before sleeping and reuses one run id", async () => {
    const observed: Array<{ status: string; attempt: number; runId: string; delay: number }> = [];
    let calls = 0;
    const jobRunner = runner({
      clock: {
        now: () => new Date(`2026-07-19T00:00:0${calls}.000Z`),
        sleep: async (delay) => {
          const row = (await runtimePool.query("select id,status,attempt from ace_hunter.job_runs")).rows[0];
          observed.push({ status: row.status, attempt: row.attempt, runId: row.id, delay });
        },
      },
    });
    const result = await jobRunner.run(baseInput, async (ctx) => {
      expect(ctx.attempt).toBe(calls);
      calls += 1;
      if (calls < 3) throw new JobError("rate_limit", true, "temporary");
      return { expected: 1, succeeded: 1, failed: [], skipped: 0 };
    });
    expect(observed.map(({ status, attempt, delay }) => ({ status, attempt, delay }))).toEqual([
      { status: "failed", attempt: 0, delay: 300_000 },
      { status: "failed", attempt: 1, delay: 1_200_000 },
    ]);
    expect(new Set([...observed.map((x) => x.runId), result.runId]).size).toBe(1);
    expect(result).toMatchObject({ executed: true, status: "success", attempt: 2 });
    expect((await runtimePool.query(
      `select error_summary,next_attempt_at,items_expected,items_succeeded,
              items_failed,items_skipped,failed_items
         from ace_hunter.job_runs where id=$1`,
      [result.runId],
    )).rows[0]).toEqual({
      error_summary: null,
      next_attempt_at: null,
      items_expected: 1,
      items_succeeded: 1,
      items_failed: 0,
      items_skipped: 0,
      failed_items: [],
    });
  });

  it("caps a retryable error at attempt two and terminally replays it", async () => {
    const sleeps: number[] = [];
    const handler = vi.fn(async () => {
      throw new JobError("timeout", true, "timeout detail");
    });
    const jobRunner = runner({
      clock: { now: () => new Date("2026-07-19T00:00:00Z"), sleep: async (ms) => { sleeps.push(ms); } },
    });
    const input = { ...baseInput, parameters: { capped: true } };
    await expect(jobRunner.run(input, handler)).rejects.toThrow("job failed (timeout)");
    expect(handler).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([300_000, 1_200_000]);
    const row = (await runtimePool.query(
      "select id,status,attempt,error_summary from ace_hunter.job_runs",
    )).rows[0];
    expect(row).toMatchObject({ status: "failed", attempt: 2, error_summary: "timeout: timeout detail" });
    expect(await jobRunner.run(input, vi.fn())).toEqual({
      runId: row.id, executed: false, status: "failed", attempt: 2,
    });
  });

  it("resumes an orphan running row but replays terminal rows", async () => {
    const jobRunner = runner();
    const first = await jobRunner.run(baseInput, async () => ({ expected: 1, succeeded: 1, failed: [], skipped: 0 }));
    const replayHandler = vi.fn();
    expect(await jobRunner.run(baseInput, replayHandler)).toEqual({ ...first, executed: false });
    await runtimePool.query("update ace_hunter.job_runs set status='running',attempt=1,completed_at=null where id=$1", [first.runId]);
    const resumed = await jobRunner.run(baseInput, async (ctx) => {
      expect(ctx.attempt).toBe(2);
      return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
    });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.executed).toBe(true);
  });

  it.each([
    [{ expected: 2, succeeded: 1, failed: [{ id: " b\n", code: "rate_limit" }], skipped: 0 }, "partial"],
    [{ expected: 1, succeeded: 0, failed: [{ id: "b", code: "made_up" }], skipped: 0 }, "failed"],
    [{ expected: 0, succeeded: 0, failed: [], skipped: 0 }, "success"],
  ] as const)("validates and persists result %#", async (jobResult, status) => {
    const result = await runner().run(
      { ...baseInput, parameters: { status } },
      async () => ({ ...jobResult, failed: [...jobResult.failed] }),
    );
    expect(result.status).toBe(status);
    const row = (await runtimePool.query("select failed_items from ace_hunter.job_runs where id=$1", [result.runId])).rows[0];
    if (jobResult.failed.length) expect(row.failed_items[0]).toMatchObject({ id: "b" });
  });

  it.each([
    { expected: 2, succeeded: 1, failed: [], skipped: 0 },
    { expected: -1, succeeded: 0, failed: [], skipped: 0 },
    { expected: Number.MAX_SAFE_INTEGER + 1, succeeded: 0, failed: [], skipped: 0 },
    { expected: 2_147_483_648, succeeded: 2_147_483_648, failed: [], skipped: 0 },
    { expected: 2, succeeded: 0, failed: [{ id: "x", code: "rate_limit" }, { id: "x", code: "rate_limit" }], skipped: 0 },
    { expected: 1, succeeded: 0, failed: [{ id: "\n", code: "rate_limit" }], skipped: 0 },
    { expected: 2, succeeded: 0, failed: [{ id: "x", code: "rate_limit" }, { id: "x\n", code: "rate_limit" }], skipped: 0 },
    { expected: 1, succeeded: 0, failed: [{ id: "x".repeat(513), code: "rate_limit" }], skipped: 0 },
  ])("rejects invalid result %#", async (jobResult) => {
    await expect(runner().run({ ...baseInput, parameters: { invalid: String(jobResult.expected) } }, async () => jobResult)).rejects.toThrow(/invalid_job_result/);
  });

  it("never retries raw, nonretryable, authentication, or validation errors and sanitizes persistence and throw", async () => {
    for (const [suffix, error] of [
      ["raw", new Error("raw database secret")],
      ["typed", new JobError("source_unavailable", false, "typed secret")],
      ["auth", new JobError("authentication_error", true, "auth secret")],
      ["validation", new JobError("validation_error", true, "validation secret")],
    ] as const) {
      const handler = vi.fn(async () => { throw error; });
      await expect(runner({ loadedSecrets: ["secret"] }).run({ ...baseInput, parameters: { suffix } }, handler)).rejects.toThrow(/job failed/);
      expect(handler).toHaveBeenCalledTimes(1);
    }
    const summaries = (await runtimePool.query("select error_summary from ace_hunter.job_runs order by created_at")).rows.map((x) => x.error_summary);
    expect(JSON.stringify(summaries)).not.toContain("secret");
    expect(summaries).toContain("unexpected_job_error");
  });

  it("redacts loaded secrets from failed item identifiers", async () => {
    const result = await runner({ loadedSecrets: ["item-secret"] }).run(
      { ...baseInput, parameters: { redactedItem: true } },
      async () => ({
        expected: 1,
        succeeded: 0,
        failed: [{ id: "prefix-item-secret\n", code: "unknown item-secret" }],
        skipped: 0,
      }),
    );
    const serialized = JSON.stringify((await runtimePool.query(
      "select failed_items from ace_hunter.job_runs where id=$1",
      [result.runId],
    )).rows[0].failed_items);
    expect(serialized).not.toContain("item-secret");
    expect(serialized).toContain("item_failed");
  });

  it("rejects secret-bearing or dangerous parameters before persistence", async () => {
    const jobRunner = runner({ loadedSecrets: ["loaded-value"] });
    for (const parameters of [
      { apiToken: "x" }, { ordinary: "loaded-value" }, { authorization: "Bearer x" },
      { "bad\nkey": "x" }, { ordinary: "bad\u0000value" },
      { database_url: "postgres://safe" }, { nested: { privateKey: "x" } },
      { session: "x" }, { dsn: "x" }, { connectionString: "x" },
    ]) {
      await expect(jobRunner.run({ ...baseInput, parameters }, vi.fn())).rejects.toThrow(/invalid_job_input/);
    }
    expect((await runtimePool.query("select count(*)::int count from ace_hunter.job_runs")).rows[0].count).toBe(0);
  });

  it("detects loaded secrets in raw strings before JSON escaping", async () => {
    const secret = 's"e\\cret雪';
    await expect(runner({ loadedSecrets: [secret] }).run(
      { ...baseInput, parameters: { ordinary: `prefix-${secret}-suffix` } },
      vi.fn(),
    )).rejects.toThrow("invalid_job_input");
  });

  it("passes immutable scheduling context and persists lineage", async () => {
    const parent = await runner().run(
      { ...baseInput, parameters: { parent: true } },
      async () => ({ expected: 0, succeeded: 0, failed: [], skipped: 0 }),
    );
    const input = {
      ...baseInput,
      triggerType: "user" as const,
      scheduledFor: new Date(baseInput.scheduledFor),
      parameters: { child: true },
      parentRunId: parent.runId,
    };
    const child = await runner().run(input, async (context) => {
      expect(context).toMatchObject({
        attempt: 0,
        scheduledFor: input.scheduledFor,
        dataCutoffAt: input.dataCutoffAt,
      });
      input.scheduledFor.setUTCFullYear(2030);
      expect(context.scheduledFor.getUTCFullYear()).toBe(2026);
      return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
    });
    const row = (await runtimePool.query(
      "select trigger_type,parent_run_id,data_cutoff_at from ace_hunter.job_runs where id=$1",
      [child.runId],
    )).rows[0];
    expect(row).toMatchObject({ trigger_type: "user", parent_run_id: parent.runId });
    expect(row.data_cutoff_at.toISOString()).toBe("2026-07-18T23:00:00.000Z");
  });

  it("resumes a crash after durable retry failure at the remaining deadline", async () => {
    const input = { ...baseInput, parameters: { restart: true } };
    const crashRunner = runner({
      clock: {
        now: () => new Date("2026-07-19T00:00:00Z"),
        sleep: async () => { throw new Error("simulated process stop"); },
      },
    });
    await expect(crashRunner.run(input, async () => {
      throw new JobError("rate_limit", true, "retry later");
    })).rejects.toThrow("job retry interrupted");
    const failed = (await runtimePool.query(
      "select id,status,attempt,next_attempt_at from ace_hunter.job_runs",
    )).rows[0];
    expect(failed).toMatchObject({ status: "failed", attempt: 0 });
    expect(failed.next_attempt_at.toISOString()).toBe("2026-07-19T00:05:00.000Z");

    const remaining: number[] = [];
    const resumed = await runner({
      clock: {
        now: () => new Date("2026-07-19T00:02:00Z"),
        sleep: async (ms) => { remaining.push(ms); },
      },
    }).run(input, async (ctx) => {
      expect(ctx.attempt).toBe(1);
      return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
    });
    expect(remaining).toEqual([180_000]);
    expect(resumed).toMatchObject({ runId: failed.id, status: "success", attempt: 1 });
  });

  it("consumes orphan attempts and refuses an exhausted running orphan", async () => {
    const input = { ...baseInput, parameters: { orphanCap: true } };
    const initial = await runner().run(input, async () => ({ expected: 0, succeeded: 0, failed: [], skipped: 0 }));
    await runtimePool.query(
      "update ace_hunter.job_runs set status='running',attempt=0,completed_at=null where id=$1",
      [initial.runId],
    );
    const firstResume = await runner().run(input, async (ctx) => {
      expect(ctx.attempt).toBe(1);
      return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
    });
    expect(firstResume).toMatchObject({ runId: initial.runId, attempt: 1 });
    await runtimePool.query(
      "update ace_hunter.job_runs set status='running',attempt=1,completed_at=null where id=$1",
      [initial.runId],
    );
    const secondResume = await runner().run(input, async (ctx) => {
      expect(ctx.attempt).toBe(2);
      return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
    });
    expect(secondResume).toMatchObject({ runId: initial.runId, attempt: 2 });
    await runtimePool.query(
      "update ace_hunter.job_runs set status='running',attempt=2,completed_at=null where id=$1",
      [initial.runId],
    );
    const handler = vi.fn();
    const exhausted = await runner().run(input, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(exhausted).toMatchObject({ runId: initial.runId, status: "failed", attempt: 2 });
    expect((await runtimePool.query(
      "select error_summary,next_attempt_at from ace_hunter.job_runs where id=$1",
      [initial.runId],
    )).rows[0]).toEqual({ error_summary: "orphan_retry_exhausted", next_attempt_at: null });
  });

  it("compares every persisted claim field before replaying a fixed key", async () => {
    const store = new JobRunStore(runtimePool);
    const original = {
      jobName: "fixed_claim",
      triggerType: "schedule" as const,
      parentRunId: null,
      scheduledFor: new Date("2026-07-19T00:00:00Z"),
      dataCutoffAt: new Date("2026-07-18T23:00:00Z"),
      parametersJson: '{"a":1}',
      startedAt: new Date("2026-07-19T00:00:00Z"),
      idempotencyKey: "fixed-claim-key",
    };
    await store.claim(original);
    for (const change of [
      { jobName: "different" },
      { triggerType: "manual" as const },
      { parentRunId: "00000000-0000-4000-8000-000000000001" },
      { scheduledFor: new Date("2026-07-19T00:00:01Z") },
      { dataCutoffAt: new Date("2026-07-18T22:00:00Z") },
      { parametersJson: '{"a":2}' },
    ]) {
      await expect(store.claim({ ...original, ...change })).rejects.toThrow(
        "job_run_claim_mismatch",
      );
    }
  });

  it("uses an independent lock pool so a max-one data pool handler can query", async () => {
    const dataPool = new Pool({ connectionString: config.runtimeDatabaseUrl, max: 1 });
    try {
      const result = await new JobRunner(dataPool, { lockPool, loadedSecrets: [] }).run(
        { ...baseInput, parameters: { maxOne: true } },
        async () => {
          expect((await dataPool.query("select 1 value")).rows[0].value).toBe(1);
          return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
        },
      );
      expect(result.status).toBe("success");
    } finally {
      await dataPool.end();
    }
  });

  it("fails closed when a colliding claim has different execution metadata", async () => {
    const input = { ...baseInput, parameters: { mismatch: true } };
    await runner().run(input, async () => ({ expected: 0, succeeded: 0, failed: [], skipped: 0 }));
    await expect(runner().run({ ...input, triggerType: "manual" }, vi.fn())).rejects.toThrow(
      "job_run_claim_mismatch",
    );
    await expect(runner().run({
      ...input,
      parentRunId: "00000000-0000-4000-8000-000000000001",
    }, vi.fn())).rejects.toThrow("job_run_claim_mismatch");
    await expect(runner().run({
      ...input,
      dataCutoffAt: new Date("2026-07-18T22:00:00Z"),
    }, vi.fn())).rejects.toThrow("job_run_claim_mismatch");
  });

  it("does not deadlock duplicates behind an externally-held lock at pool capacity", async () => {
    const input = { ...baseInput, parameters: { externalLock: true } };
    const first = await runner().run(input, async () => ({ expected: 0, succeeded: 0, failed: [], skipped: 0 }));
    const key = (await runtimePool.query(
      "select idempotency_key from ace_hunter.job_runs where id=$1",
      [first.runId],
    )).rows[0].idempotency_key;
    const external = await lockPool.connect();
    try {
      await external.query("select pg_advisory_lock(hashtextextended($1,0))", [key]);
      const duplicateHandler = vi.fn();
      const duplicates = Array.from({ length: 12 }, () => runner().run(input, duplicateHandler));
      const outcomes = await Promise.race([
        Promise.all(duplicates),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlock")), 2_000)),
      ]);
      expect(duplicateHandler).not.toHaveBeenCalled();
      expect(outcomes.every((value) => value.runId === first.runId && !value.executed)).toBe(true);
    } finally {
      await external.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
      external.release();
    }
  });

  it("requires explicit independent pools and never exposes handler secrets in the rejected error", async () => {
    expect(() => new JobRunner(runtimePool, { lockPool: runtimePool, loadedSecrets: [] }))
      .toThrow("invalid_job_runner_options");
    const secret = "never-print-this-secret";
    let rejected: Error | undefined;
    try {
      await runner({ loadedSecrets: [secret] }).run(
        { ...baseInput, parameters: { sanitizedThrow: true } },
        async () => { throw new Error(`raw ${secret}`); },
      );
    } catch (error) {
      rejected = error as Error;
    }
    expect(rejected?.message).toBe("job failed (unexpected_job_error)");
    expect(rejected?.stack).not.toContain(secret);
  });

  it("clones dates before awaiting a database connection", async () => {
    const scheduledFor = new Date("2026-07-19T00:00:00Z");
    const dataCutoffAt = new Date("2026-07-18T23:00:00Z");
    const promise = runner().run(
      { ...baseInput, parameters: { cloned: true }, scheduledFor, dataCutoffAt },
      async (ctx) => {
        expect(ctx.scheduledFor.toISOString()).toBe("2026-07-19T00:00:00.000Z");
        expect(ctx.dataCutoffAt?.toISOString()).toBe("2026-07-18T23:00:00.000Z");
        return { expected: 0, succeeded: 0, failed: [], skipped: 0 };
      },
    );
    scheduledFor.setUTCFullYear(2030);
    dataCutoffAt.setUTCFullYear(2030);
    await promise;
    const row = (await runtimePool.query("select scheduled_for,data_cutoff_at from ace_hunter.job_runs")).rows[0];
    expect(row.scheduled_for.toISOString()).toBe("2026-07-19T00:00:00.000Z");
    expect(row.data_cutoff_at.toISOString()).toBe("2026-07-18T23:00:00.000Z");
  });
});
