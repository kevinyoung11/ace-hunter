import type { Command } from "commander";
import type { CliDependencies } from "../index.js";
import { executeCommand } from "../output.js";

export interface WorkerOptions { once?: boolean; pollSeconds?: string; workerId?: string }

export function registerWorkerCommand(program: Command, dependencies: CliDependencies): void {
  const command = program.command("worker").description("Run a local executor worker");
  command.command("x")
    .description("Process queued X commands")
    .option("--once", "process at most one command")
    .option("--poll-seconds <seconds>", "poll interval", "30")
    .option("--worker-id <id>", "stable worker identity")
    .action(async (options: WorkerOptions) => {
      await executeCommand(dependencies.io, async () => {
        if (!dependencies.worker) throw Object.assign(new Error("configuration_error"), { code: "configuration_error" });
        const pollSeconds = parsePollSeconds(options.pollSeconds ?? "30");
        const workerId = options.workerId ?? process.env.ACE_HUNTER_WORKER_ID ?? `mac-${process.pid}`;
        return dependencies.worker({ workerId, once: options.once === true, pollSeconds });
      });
    });
}

function parsePollSeconds(value: string): number {
  if (!/^\d+$/.test(value)) throw Object.assign(new Error("invalid_poll_seconds"), { code: "invalid_poll_seconds" });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3600) throw Object.assign(new Error("invalid_poll_seconds"), { code: "invalid_poll_seconds" });
  return parsed;
}
