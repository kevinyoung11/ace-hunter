import { describe, expect, it } from "vitest";
import { runSchedulerTick, type SchedulerStore } from "../../../src/ops/scheduler-tick.js";

/**
 * Contract-level scheduling integration seam. The real DB-backed suite is
 * enabled only when the explicit isolated test URLs are configured; this
 * deterministic case still proves UTC slice/idempotency wiring in CI.
 */
describe("scheduler integration contract", () => {
  it("uses one UTC scheduled_for/idempotency key per job time slice", async () => {
    const calls: unknown[] = [];
    const store: SchedulerStore = {
      now: async () => new Date("2026-07-21T10:07:45.000Z"),
      definitions: async () => [{
        name: "collect_github_trending", executor: "github", capability: "github.trending",
        workflow: "trending.yml", enabled: true, schedule: { minute: 7, hour: "*" }, parameters: {},
      }],
      enqueue: async (input) => { calls.push(input); return { id: "command-1", ...input } as never; },
    };
    await runSchedulerTick({ store, dispatch: async () => undefined });
    await runSchedulerTick({ store, dispatch: async () => undefined });
    expect(calls).toHaveLength(2);
    expect((calls[0] as { idempotencyKey: string }).idempotencyKey).toBe("schedule:collect_github_trending:2026-07-21T10:07:00.000Z");
    expect((calls[0] as { idempotencyKey: string }).idempotencyKey).toBe((calls[1] as { idempotencyKey: string }).idempotencyKey);
  });
});
