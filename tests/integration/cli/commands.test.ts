import { expect, it, vi } from "vitest";
import {
  createProgram,
  type CliDependencies,
  type CliExitCode,
} from "../../../src/cli/index.js";

function harness(overrides: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: CliExitCode[] = [];
  const dependencies: CliDependencies = {
    today: vi.fn(async () => ({ renderedMarkdown: "# Today\n", structuredContent: { z: 1, a: 2 } })),
    analyze: vi.fn(async (target) => ({ kind: "found", target, renderedMarkdown: `# ${target}\n`, structuredContent: { target } })),
    observe: vi.fn(async (target) => ({ kind: "found", target, status: "partial", missingSources: ["x"] })),
    follow: vi.fn(async (target) => ({ kind: "followed", target })),
    listMonitors: vi.fn(async () => ({ monitors: [{ id: "m", name: "One" }] })),
    unfollow: vi.fn(async (target) => ({ kind: "unfollowed", target })),
    runJob: vi.fn(async (input) => ({ runId: "job-1", input })),
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      exit: (code) => exits.push(code),
    },
    ...overrides,
  };
  return { program: createProgram(dependencies), dependencies, stdout, stderr, exits };
}

async function invoke(args: string[], overrides: Partial<CliDependencies> = {}) {
  const value = harness(overrides);
  await value.program.parseAsync(["node", "ace-hunter", ...args]);
  return value;
}

it("registers every Skill command and renders deterministic Markdown or JSON", async () => {
  const today = await invoke(["today"]);
  expect(today.stdout).toEqual(["# Today\n"]);

  const json = await invoke(["today", "--format", "json"]);
  expect(json.stdout).toEqual(["{\n  \"a\": 2,\n  \"z\": 1\n}\n"]);

  for (const args of [
    ["analyze", "owner/repo"],
    ["observe", "owner/repo"],
    ["follow", "owner/repo"],
    ["list"],
    ["unfollow", "owner/repo"],
  ]) {
    const result = await invoke(args);
    expect(result.exits).toEqual([]);
    expect(result.stdout).toHaveLength(1);
  }
});

it("returns ambiguity as stable JSON with exit 2 and treats a partial observation as success", async () => {
  const ambiguous = await invoke(["analyze", "Open"], {
    analyze: async () => ({
      kind: "ambiguous",
      candidates: [{ name: "Open", id: "b" }, { id: "a", name: "Open" }],
    }),
  });
  expect(ambiguous.exits).toEqual([2]);
  expect(JSON.parse(ambiguous.stdout[0])).toEqual({
    candidates: [{ id: "b", name: "Open" }, { id: "a", name: "Open" }],
    kind: "ambiguous",
  });

  const partial = await invoke(["observe", "owner/repo", "--format", "json"]);
  expect(partial.exits).toEqual([]);
  expect(JSON.parse(partial.stdout[0])).toMatchObject({ status: "partial" });
});

it("maps configuration and authentication failures to exit 1 without leaking their values", async () => {
  const failed = await invoke(["today"], {
    today: async () => {
      throw Object.assign(new Error("secret must not be rendered"), { code: "authentication_error" });
    },
  });
  expect(failed.exits).toEqual([1]);
  expect(failed.stderr.join("")).toContain("authentication_error");
  expect(failed.stderr.join("")).not.toContain("secret must not be rendered");
});

it("preserves a real job execution error instead of relabeling it as attribution", async () => {
  const failed = await invoke([
    "job", "discover_github_candidates",
    "--orchestrator-run-id", "123",
    "--orchestrator-run-attempt", "1",
    "--orchestrator-workflow", "discover.yml",
  ], {
    runJob: async () => {
      throw Object.assign(new Error("database details"), { code: "source_unavailable" });
    },
  });
  expect(failed.exits).toEqual([1]);
  expect(failed.stderr).toEqual(["source_unavailable\n"]);
});

it("accepts exact hosted and launchd attribution and forwards no unknown metadata", async () => {
  const hosted = await invoke([
    "job", "discover_github_candidates",
    "--scheduled-for", "2026-07-19T00:00:00.000Z",
    "--max-new", "25",
    "--orchestrator-run-id", "12345678901234567890",
    "--orchestrator-run-attempt", "100",
    "--orchestrator-workflow", "discover.yml",
  ]);
  expect(hosted.dependencies.runJob).toHaveBeenCalledWith({
    name: "discover_github_candidates",
    triggerType: "schedule",
    scheduledFor: new Date("2026-07-19T00:00:00.000Z"),
    parameters: {
      max_new: 25,
      orchestrator_run_attempt: "100",
      orchestrator_run_id: "12345678901234567890",
      orchestrator_workflow: "discover.yml",
    },
  });

  const schedulerRunId = "123e4567-e89b-42d3-a456-426614174000";
  const local = await invoke([
    "job", "collect_x_posts",
    "--scheduled-for", "2026-07-19T00:00:00Z",
    "--scheduler", "launchd",
    "--scheduler-run-id", schedulerRunId,
  ]);
  expect(local.dependencies.runJob).toHaveBeenCalledWith(expect.objectContaining({
    triggerType: "schedule",
    scheduledFor: new Date("2026-07-19T00:00:00.000Z"),
    parameters: { scheduler: "launchd", scheduler_run_id: schedulerRunId },
  }));
});

it.each([
  ["incomplete hosted", ["--orchestrator-run-id", "123"]],
  ["incomplete local", ["--scheduler", "launchd"]],
  ["mixed", ["--orchestrator-run-id", "123", "--orchestrator-run-attempt", "1", "--orchestrator-workflow", "discover.yml", "--scheduler", "launchd", "--scheduler-run-id", "123e4567-e89b-42d3-a456-426614174000"]],
  ["nondecimal id", ["--orchestrator-run-id", "12a", "--orchestrator-run-attempt", "1", "--orchestrator-workflow", "discover.yml"]],
  ["overlength id", ["--orchestrator-run-id", "123456789012345678901", "--orchestrator-run-attempt", "1", "--orchestrator-workflow", "discover.yml"]],
  ["bad attempt", ["--orchestrator-run-id", "123", "--orchestrator-run-attempt", "101", "--orchestrator-workflow", "discover.yml"]],
  ["noncanonical attempt", ["--orchestrator-run-id", "123", "--orchestrator-run-attempt", "001", "--orchestrator-workflow", "discover.yml"]],
  ["workflow not allowlisted", ["--orchestrator-run-id", "123", "--orchestrator-run-attempt", "1", "--orchestrator-workflow", "evil.yml"]],
  ["bad scheduler uuid", ["--scheduler", "launchd", "--scheduler-run-id", "not-a-uuid"]],
  ["control character", ["--scheduler", "launchd\n", "--scheduler-run-id", "123e4567-e89b-42d3-a456-426614174000"]],
])("rejects %s attribution atomically", async (_name, attribution) => {
  const result = await invoke(["job", "collect_x_posts", ...attribution]);
  expect(result.exits).toEqual([1]);
  expect(result.dependencies.runJob).not.toHaveBeenCalled();
  expect(result.stderr.join("")).toContain("invalid_job_attribution");
});

it("reserves launchd attribution for local X pipeline jobs", async () => {
  const result = await invoke([
    "job", "discover_github_candidates",
    "--scheduler", "launchd",
    "--scheduler-run-id", "123e4567-e89b-42d3-a456-426614174000",
  ]);
  expect(result.exits).toEqual([1]);
  expect(result.dependencies.runJob).not.toHaveBeenCalled();
  for (const jobName of ["analyze_x_posts", "collect_x_comments"]) {
    const accepted = await invoke([
      "job", jobName,
      "--scheduler", "launchd",
      "--scheduler-run-id", "123e4567-e89b-42d3-a456-426614174000",
    ]);
    expect(accepted.exits).toEqual([]);
    expect(accepted.dependencies.runJob).toHaveBeenCalledTimes(1);
  }
});

it("rejects unknown job metadata before execution", async () => {
  const value = harness();
  await expect(value.program.parseAsync([
    "node", "ace-hunter", "job", "collect_x_posts", "--unknown-metadata", "value",
  ])).rejects.toMatchObject({ code: "commander.unknownOption" });
  expect(value.dependencies.runJob).not.toHaveBeenCalled();
});
