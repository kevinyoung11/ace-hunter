import type { Command } from "commander";
import type { CliDependencies } from "../index.js";
import { executeCommand } from "../output.js";

export function registerMonitorsCommand(program: Command, dependencies: CliDependencies): void {
  program
    .command("list")
    .description("List followed products")
    .action(async () => {
      await executeCommand(dependencies.io, dependencies.listMonitors);
    });
}
