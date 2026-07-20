#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import type { JobInput } from "../jobs/job-runner.js";
import { loadRedactionRegistry } from "../config/load-config.js";
import { log } from "../core/logger.js";
import type { PotentialRule } from "../reports/potential-list.js";
import type { TrendingListPeriod } from "../reports/trending-list.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerFollowCommands } from "./commands/follow.js";
import { registerJobCommand } from "./commands/jobs.js";
import { registerMonitorsCommand } from "./commands/monitors.js";
import { registerObserveCommand } from "./commands/observe.js";
import { registerPotentialCommand } from "./commands/potential.js";
import { registerTodayCommand } from "./commands/today.js";
import { registerTrendingCommand } from "./commands/trending.js";
import { processIo, type CliIo, type CommandOutput } from "./output.js";
import { createLazyProductionCliRuntime } from "./runtime-dependencies.js";

export type { CliExitCode } from "./output.js";

export interface CliDependencies {
  today(): Promise<CommandOutput>;
  potential(options: { rule: PotentialRule; limit: number | null }): Promise<CommandOutput>;
  trending(options: { period: TrendingListPeriod; limit: number | null }): Promise<CommandOutput>;
  analyze(target: string): Promise<CommandOutput>;
  observe(target: string): Promise<CommandOutput>;
  follow(target: string): Promise<CommandOutput>;
  listMonitors(): Promise<CommandOutput>;
  unfollow(target: string): Promise<CommandOutput>;
  runJob(input: JobInput): Promise<CommandOutput>;
  io: CliIo;
  now?: () => Date;
}

export function createProgram(dependencies: CliDependencies): Command {
  const program = new Command()
    .name("ace-hunter")
    .description("Discover and observe promising open-source products")
    .version("0.1.0")
    .exitOverride();

  registerTodayCommand(program, dependencies);
  registerPotentialCommand(program, dependencies);
  registerTrendingCommand(program, dependencies);
  registerAnalyzeCommand(program, dependencies);
  registerObserveCommand(program, dependencies);
  registerFollowCommands(program, dependencies);
  registerMonitorsCommand(program, dependencies);
  registerJobCommand(program, dependencies);
  return program;
}

function unavailable(): Promise<never> {
  return Promise.reject(Object.assign(new Error("runtime dependencies unavailable"), {
    code: "configuration_error",
  }));
}

export function unavailableDependencies(io: CliIo = processIo): CliDependencies {
  return {
    today: unavailable,
    potential: unavailable,
    trending: unavailable,
    analyze: unavailable,
    observe: unavailable,
    follow: unavailable,
    listMonitors: unavailable,
    unfollow: unavailable,
    runJob: unavailable,
    io,
  };
}

async function main(): Promise<void> {
  let commanderErrorOutput = "";
  const runtime = createLazyProductionCliRuntime(process.env);
  const program = createProgram(runtime.dependencies).configureOutput({
    writeErr: (value) => {
      commanderErrorOutput += value;
    },
  });
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (
      error instanceof CommanderError &&
      ["commander.helpDisplayed", "commander.version"].includes(error.code)
    ) {
      process.exitCode = 0;
      return;
    }
    log(
      "error",
      error instanceof CommanderError
        ? `CLI argument error: ${error.code}`
        : commanderErrorOutput.trim() || "CLI command failed",
      loadRedactionRegistry(process.env),
    );
    process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
