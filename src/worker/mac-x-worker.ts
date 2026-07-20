import { redact } from "../core/logger.js";
import type { JobInput } from "../jobs/job-runner.js";
import type { JobDispatcher } from "../cli/job-dispatcher.js";
import type { CommandService } from "../ops/command-service.js";
import type { JobCommand } from "../db/stores/job-command-store.js";

export const MAC_X_CAPABILITIES = ["x.posts.collect", "x.posts.analyze", "x.comments.collect"] as const;
export const MAC_X_JOBS = ["collect_x_posts", "analyze_x_posts", "collect_x_comments"] as const;
type MacXJob = typeof MAC_X_JOBS[number];

export interface MacXWorkerOptions {
  service: Pick<CommandService, "heartbeat" | "claim" | "start" | "bind" | "complete">;
  dispatcher: JobDispatcher;
  workerId: string;
  version?: string;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface WorkerTickResult {
  processed: boolean;
  commandId?: string;
  status?: "succeeded" | "partial" | "failed";
  reason?: "idle";
}

export class MacXWorker {
  private readonly now: () => Date;
  public constructor(private readonly options: MacXWorkerOptions) {
    if (!/^[-a-zA-Z0-9_.:]{1,128}$/.test(options.workerId)) throw new Error("invalid_worker_id");
    this.now = options.now ?? (() => new Date());
  }

  public async tick(): Promise<WorkerTickResult> {
    await retryTransient(() => this.options.service.heartbeat(this.options.workerId, "local", [...MAC_X_CAPABILITIES], this.options.version, { worker: "mac-x" }));
    const command = await retryTransient(() => this.options.service.claim(this.options.workerId, "local", [...MAC_X_CAPABILITIES]));
    if (!command) return { processed: false, reason: "idle" };
    this.assertCommand(command);
    const started = await this.options.service.start(command.id, this.options.workerId);
    if (!started) throw Object.assign(new Error("command_lease_lost"), { code: "command_lease_lost" });
    const input: JobInput = {
      name: command.jobName,
      triggerType: "schedule",
      scheduledFor: command.scheduledFor ?? this.now(),
      parameters: { ...command.parameters, command_id: command.id },
      commandId: command.id,
    };
    try {
      const output = await this.options.dispatcher(input);
      if (!output.runId) throw Object.assign(new Error("job_run_missing"), { code: "job_run_missing" });
      await this.options.service.bind(command.id, this.options.workerId, output.runId);
      const status = terminalStatus(output.status);
      await this.options.service.complete(command.id, this.options.workerId, status);
      return { processed: true, commandId: command.id, status };
    } catch (error) {
      const code = safeCode(error);
      const message = redact(error instanceof Error ? error.message : String(error));
      try { await this.options.service.complete(command.id, this.options.workerId, "failed", code, message); } catch { /* lease loss is reported by the original stable code */ }
      return { processed: true, commandId: command.id, status: "failed" };
    }
  }

  public async run(options: { once?: boolean; pollSeconds?: number; signal?: AbortSignal } = {}): Promise<void> {
    const once = options.once ?? false;
    const pollSeconds = options.pollSeconds ?? 30;
    if (!Number.isInteger(pollSeconds) || pollSeconds < 1 || pollSeconds > 3600) throw new Error("invalid_poll_seconds");
    do {
      await this.tick();
      if (once) return;
      if (options.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollSeconds * 1000);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    } while (!options.signal?.aborted);
  }

  private assertCommand(command: JobCommand): asserts command is JobCommand & { jobName: MacXJob } {
    if (command.executor !== "local" || !MAC_X_JOBS.includes(command.jobName as MacXJob) || !MAC_X_CAPABILITIES.includes(command.capability as typeof MAC_X_CAPABILITIES[number])) {
      throw Object.assign(new Error("worker_command_rejected"), { code: "worker_command_rejected" });
    }
    const expected = command.jobName === "collect_x_posts" ? "x.posts.collect" : command.jobName === "analyze_x_posts" ? "x.posts.analyze" : "x.comments.collect";
    if (command.capability !== expected) throw Object.assign(new Error("worker_command_rejected"), { code: "worker_command_rejected" });
    if (command.jobName !== "collect_x_posts") {
      const lineage = command.parameters.lineage;
      if (!lineage || typeof lineage !== "object" || typeof (lineage as Record<string, unknown>).parent_command_id !== "string") {
        throw Object.assign(new Error("x_lineage_required"), { code: "x_lineage_required" });
      }
      const parentProduct = (lineage as Record<string, unknown>).parent_product_id;
      const product = command.parameters.productId ?? command.parameters.product_id;
      if (parentProduct !== undefined && product !== undefined && parentProduct !== product) {
        throw Object.assign(new Error("x_lineage_mismatch"), { code: "x_lineage_mismatch" });
      }
    }
  }
}

async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  let delay = 100;
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      const code = safeCode(error);
      if (attempt >= 2 || !new Set(["timeout", "network_error", "connection_error", "worker_unavailable"]).has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

function terminalStatus(status: string): "succeeded" | "partial" | "failed" {
  if (status === "partial") return "partial";
  if (status === "failed") return "failed";
  return "succeeded";
}
function safeCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "worker_command_failed";
}
