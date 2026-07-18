import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { JobError, JobRunner, type JobInput } from "../../../src/jobs/job-runner.js";
import { createVerifiedTestPools, parseTestDatabaseConfig } from "../../helpers/test-database.js";

const config = parseTestDatabaseConfig(process.env);
let adminPool: Pool;
let runtimePool: Pool;
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
});
beforeEach(async () => adminPool.query("truncate ace_hunter.job_runs cascade"));
afterAll(async () => Promise.all([adminPool.end(), runtimePool.end()]));

describe("JobRunner", () => {
  it("lets only one of twenty live duplicates execute", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.fn(async () => {
      await barrier;
      return { expected: 1, succeeded: 1, failed: [], skipped: 0 };
    });
    const runner = new JobRunner(runtimePool);
    const first = runner.run(baseInput, handler);
    while (handler.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const duplicates = Array.from({ length: 19 }, () => runner.run(baseInput, handler));
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
    const runner = new JobRunner(runtimePool);
    await Promise.all([
      runner.run({ ...baseInput, parameters: { key: 1 } }, handler),
      runner.run({ ...baseInput, parameters: { key: 2 } }, handler),
    ]);
    expect(peak).toBe(2);
  });

  it("persists each typed failed attempt before sleeping and reuses one run id", async () => {
    const observed: Array<{ status: string; attempt: number; runId: string; delay: number }> = [];
    let calls = 0;
    const runner = new JobRunner(runtimePool, {
      clock: {
        now: () => new Date(`2026-07-19T00:00:0${calls}.000Z`),
        sleep: async (delay) => {
          const row = (await runtimePool.query("select id,status,attempt from ace_hunter.job_runs")).rows[0];
          observed.push({ status: row.status, attempt: row.attempt, runId: row.id, delay });
        },
      },
    });
    const result = await runner.run(baseInput, async (ctx) => {
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
  });

  it("caps a retryable error at attempt two and terminally replays it", async () => {
    const sleeps: number[] = [];
    const handler = vi.fn(async () => {
      throw new JobError("timeout", true, "timeout detail");
    });
    const runner = new JobRunner(runtimePool, {
      clock: { now: () => new Date("2026-07-19T00:00:00Z"), sleep: async (ms) => { sleeps.push(ms); } },
    });
    const input = { ...baseInput, parameters: { capped: true } };
    await expect(runner.run(input, handler)).rejects.toThrow("job failed (timeout)");
    expect(handler).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([300_000, 1_200_000]);
    const row = (await runtimePool.query(
      "select id,status,attempt,error_summary from ace_hunter.job_runs",
    )).rows[0];
    expect(row).toMatchObject({ status: "failed", attempt: 2, error_summary: "timeout: timeout detail" });
    expect(await runner.run(input, vi.fn())).toEqual({
      runId: row.id, executed: false, status: "failed", attempt: 2,
    });
  });

  it("resumes an orphan running row but replays terminal rows", async () => {
    const runner = new JobRunner(runtimePool);
    const first = await runner.run(baseInput, async () => ({ expected: 1, succeeded: 1, failed: [], skipped: 0 }));
    const replayHandler = vi.fn();
    expect(await runner.run(baseInput, replayHandler)).toEqual({ ...first, executed: false });
    await runtimePool.query("update ace_hunter.job_runs set status='running',completed_at=null where id=$1", [first.runId]);
    const resumed = await runner.run(baseInput, async () => ({ expected: 0, succeeded: 0, failed: [], skipped: 0 }));
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.executed).toBe(true);
  });

  it.each([
    [{ expected: 2, succeeded: 1, failed: [{ id: " b\n", code: "rate_limit" }], skipped: 0 }, "partial"],
    [{ expected: 1, succeeded: 0, failed: [{ id: "b", code: "made_up" }], skipped: 0 }, "failed"],
    [{ expected: 0, succeeded: 0, failed: [], skipped: 0 }, "success"],
  ] as const)("validates and persists result %#", async (jobResult, status) => {
    const result = await new JobRunner(runtimePool).run(
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
    { expected: 2, succeeded: 0, failed: [{ id: "x", code: "rate_limit" }, { id: "x", code: "rate_limit" }], skipped: 0 },
  ])("rejects invalid result %#", async (jobResult) => {
    await expect(new JobRunner(runtimePool).run({ ...baseInput, parameters: { invalid: String(jobResult.expected) } }, async () => jobResult)).rejects.toThrow(/invalid_job_result/);
  });

  it("never retries raw, nonretryable, authentication, or validation errors and sanitizes persistence and throw", async () => {
    for (const [suffix, error] of [
      ["raw", new Error("raw database secret")],
      ["typed", new JobError("source_unavailable", false, "typed secret")],
      ["auth", new JobError("authentication_error", true, "auth secret")],
      ["validation", new JobError("validation_error", true, "validation secret")],
    ] as const) {
      const handler = vi.fn(async () => { throw error; });
      await expect(new JobRunner(runtimePool, { loadedSecrets: ["secret"] }).run({ ...baseInput, parameters: { suffix } }, handler)).rejects.toThrow(/job failed/);
      expect(handler).toHaveBeenCalledTimes(1);
    }
    const summaries = (await runtimePool.query("select error_summary from ace_hunter.job_runs order by created_at")).rows.map((x) => x.error_summary);
    expect(JSON.stringify(summaries)).not.toContain("secret");
    expect(summaries).toContain("unexpected_job_error");
  });

  it("redacts loaded secrets from failed item identifiers", async () => {
    const result = await new JobRunner(runtimePool, { loadedSecrets: ["item-secret"] }).run(
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
    const runner = new JobRunner(runtimePool, { loadedSecrets: ["loaded-value"] });
    for (const parameters of [
      { apiToken: "x" }, { ordinary: "loaded-value" }, { authorization: "Bearer x" },
      { "bad\nkey": "x" }, { ordinary: "bad\u0000value" },
    ]) {
      await expect(runner.run({ ...baseInput, parameters }, vi.fn())).rejects.toThrow(/invalid_job_input/);
    }
    expect((await runtimePool.query("select count(*)::int count from ace_hunter.job_runs")).rows[0].count).toBe(0);
  });

  it("passes immutable scheduling context and persists lineage", async () => {
    const parent = await new JobRunner(runtimePool).run(
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
    const child = await new JobRunner(runtimePool).run(input, async (context) => {
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
});
