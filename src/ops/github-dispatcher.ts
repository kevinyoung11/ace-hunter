import type { JobCommand } from "../db/stores/job-command-store.js";
import type { JobDispatcher } from "../cli/job-dispatcher";
import type { JobInput } from "../jobs/job-runner";
import { JOB_CATALOG, type Executor, type JobName } from "./job-catalog";

export interface GitHubDispatchCommand { workflow: string; jobName: JobName; commandId: string }
export interface GitHubDispatcherOptions { owner: string; repo: string; token: string; ref?: string; request?: typeof fetch }
const workflowAllowlist: ReadonlySet<string> = new Set(JOB_CATALOG.map(([, , , workflow]) => workflow));
const commandPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function dispatchGitHubWorkflow(options: GitHubDispatcherOptions, command: GitHubDispatchCommand): Promise<void> {
  if (!workflowAllowlist.has(command.workflow) || !commandIdValid(command.commandId) || !JOB_CATALOG.some(([name, executor, , workflow]) => name === command.jobName && executor === "github" && workflow === command.workflow)) {
    throw Object.assign(new Error("invalid dispatch request"), { code: "validation_error" });
  }
  const request = options.request ?? fetch;
  // All durable commands enter the single lifecycle workflow; catalog workflow
  // names remain an allowlisted attribution/validation field.
  const response = await request(`https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/actions/workflows/ops-command.yml/dispatches`, {
    method: "POST", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${options.token}`, "content-type": "application/json", "user-agent": "ace-hunter-ops" },
    body: JSON.stringify({ ref: options.ref ?? "main", inputs: { job_name: command.jobName, command_id: command.commandId } }),
  });
  if (!response.ok) throw Object.assign(new Error(`github dispatch failed (${response.status})`), { code: "github_dispatch_failed", status: response.status });
}
export class GitHubDispatcher {
  public constructor(private readonly options: GitHubDispatcherOptions) {}
  public dispatch(command: GitHubDispatchCommand): Promise<void> { return dispatchGitHubWorkflow(this.options, command); }
}
function commandIdValid(id: string): boolean { return commandPattern.test(id); }

export interface GitHubCommandLifecycleStore {
  get(commandId: string): Promise<JobCommand | null>;
  claim(commandId: string, workerId: string, executor: Executor, capabilities: string[]): Promise<JobCommand | null>;
  start(commandId: string, workerId: string): Promise<JobCommand | null>;
  bind(commandId: string, workerId: string, jobRunId: string): Promise<JobCommand | null>;
  complete(commandId: string, workerId: string, status: "succeeded" | "partial" | "failed", errorCode?: string, errorMessage?: string): Promise<JobCommand | null>;
}
export interface GitHubExecutionResult { runId: string; status: "succeeded" | "partial" | "failed"; errorCode?: string; errorMessage?: string }
export async function executeGitHubCommand(options: { commandId: string; workerId: string; store: GitHubCommandLifecycleStore; run: (command: JobCommand) => Promise<GitHubExecutionResult> }): Promise<GitHubExecutionResult> {
  const existing = await options.store.get(options.commandId);
  if (!existing || existing.executor !== "github") throw Object.assign(new Error("command_not_found"), { code: "command_not_found" });
  const claimed = await options.store.claim(options.commandId, options.workerId, "github", [existing.capability]);
  if (!claimed) throw Object.assign(new Error("command_not_claimable"), { code: "command_not_claimable" });
  try {
    const started = await options.store.start(options.commandId, options.workerId);
    if (!started) throw Object.assign(new Error("command_lease_lost"), { code: "command_lease_lost" });
    const result = await options.run(claimed);
    const bound = await options.store.bind(options.commandId, options.workerId, result.runId);
    if (!bound) throw Object.assign(new Error("command_bind_failed"), { code: "command_bind_failed" });
    const completed = await options.store.complete(options.commandId, options.workerId, result.status, result.errorCode, result.errorMessage);
    if (!completed) throw Object.assign(new Error("command_complete_failed"), { code: "command_complete_failed" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 256) : "github command failed";
    await options.store.complete(options.commandId, options.workerId, "failed", "executor_error", message);
    throw error;
  }
}

/** Executes a claimed durable command through the real application dispatcher. */
export class GitHubCommandExecutor {
  public constructor(
    private readonly store: GitHubCommandLifecycleStore,
    private readonly dispatcher: JobDispatcher,
  ) {}

  public async execute(commandId: string, workerId: string): Promise<GitHubExecutionResult> {
    return executeGitHubCommand({
      commandId,
      workerId,
      store: this.store,
      run: async (command) => {
        const input: JobInput = {
          name: command.jobName,
          triggerType: command.scheduledFor ? "schedule" : "manual",
          scheduledFor: command.scheduledFor ?? new Date(),
          parameters: command.parameters,
          commandId: command.id,
        };
        try {
          const output = await this.dispatcher(input);
          const status = output.status === "partial" ? "partial" : output.status === "failed" ? "failed" : "succeeded";
          return { runId: output.runId, status };
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "executor_error";
          throw Object.assign(error instanceof Error ? error : new Error("github command failed"), { code });
        }
      },
    });
  }
}
