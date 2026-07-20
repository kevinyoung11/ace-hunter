import { describe, expect, it, vi } from "vitest";
import { MacXWorker } from "../../../src/worker/mac-x-worker.js";
import type { JobCommand } from "../../../src/db/stores/job-command-store.js";
import type { Executor } from "../../../src/ops/job-catalog.js";

const command = (overrides: Partial<JobCommand> = {}): JobCommand => ({
  id: "11111111-1111-4111-8111-111111111111",
  jobName: "collect_x_posts",
  executor: "local",
  capability: "x.posts.collect",
  parameters: {},
  status: "queued",
  idempotencyKey: "idem",
  scheduledFor: new Date("2026-07-21T00:00:00.000Z"),
  jobRunId: null,
  ...overrides,
});

function deps(overrides: { service?: Record<string, unknown> } = {}) {
  const events: string[] = [];
  const service = {
    heartbeat: vi.fn(async () => { events.push("heartbeat"); return {}; }),
    claim: vi.fn(async () => { events.push("claim"); return command(); }),
    start: vi.fn(async () => { events.push("start"); return command({ status: "running" }); }),
    bind: vi.fn(async () => { events.push("bind"); return command({ status: "running", jobRunId: "22222222-2222-4222-8222-222222222222" }); }),
    complete: vi.fn(async () => { events.push("complete"); return command({ status: "succeeded" }); }),
    ...overrides.service,
  };
  const dispatcher = vi.fn(async () => { events.push("dispatch"); return { kind: "job_run", runId: "22222222-2222-4222-8222-222222222222", status: "success", executed: true }; });
  return { events, service, dispatcher, dependencies: { service, dispatcher, workerId: "mac-1", version: "v1" } };
}

describe("MacXWorker", () => {
  it("heartbeats, claims, starts, dispatches, binds and completes one command", async () => {
    const fixture = deps();
    const worker = new MacXWorker(fixture.dependencies);
    const result = await worker.tick();
    expect(result).toMatchObject({ processed: true, commandId: command().id, status: "succeeded" });
    expect(fixture.events).toEqual(["heartbeat", "claim", "start", "dispatch", "bind", "complete"]);
    expect(fixture.dispatcher).toHaveBeenCalledWith(expect.objectContaining({
      name: "collect_x_posts", commandId: command().id,
    }));
  });

  it("skips duplicate/empty claims without executing a JobRun", async () => {
    const fixture = deps({ service: { claim: vi.fn(async () => null) } });
    const worker = new MacXWorker(fixture.dependencies);
    await expect(worker.tick()).resolves.toMatchObject({ processed: false });
    expect(fixture.dispatcher).not.toHaveBeenCalled();
  });

  it.each([
    ["github", "github.candidates"],
    ["local", "github.candidates"],
    ["local", "x.unknown"],
  ])("rejects non-local/X command %s/%s", async (executor, capability) => {
    const fixture = deps({ service: { claim: vi.fn(async () => command({ executor: executor as Executor, capability })) } });
    const worker = new MacXWorker(fixture.dependencies);
    await expect(worker.tick()).rejects.toMatchObject({ code: "worker_command_rejected" });
    expect(fixture.dispatcher).not.toHaveBeenCalled();
    expect(fixture.service.complete).not.toHaveBeenCalled();
  });

  it("marks command failed with a redacted stable error when dispatch fails", async () => {
    const fixture = deps();
    fixture.dispatcher.mockRejectedValue(Object.assign(new Error("postgres://u:secret@example/db"), { code: "source_unavailable" }));
    const worker = new MacXWorker(fixture.dependencies);
    await expect(worker.tick()).resolves.toMatchObject({ processed: true, status: "failed" });
    expect(fixture.service.complete).toHaveBeenCalledWith(command().id, "mac-1", "failed", "source_unavailable", expect.not.stringContaining("secret"));
  });

  it("rejects downstream X commands without a parent lineage reference", async () => {
    const fixture = deps({ service: { claim: vi.fn(async () => command({ jobName: "analyze_x_posts", capability: "x.posts.analyze" })) } });
    await expect(new MacXWorker(fixture.dependencies).tick()).rejects.toMatchObject({ code: "x_lineage_required" });
  });

  it("backs off transient heartbeat/claim failures while preserving the queued command", async () => {
    const fixture = deps();
    fixture.service.heartbeat
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { code: "network_error" }));
    await expect(new MacXWorker(fixture.dependencies).tick()).resolves.toMatchObject({ processed: true });
    expect(fixture.service.heartbeat).toHaveBeenCalledTimes(2);
  });
});
