import type { Command } from "commander";
import type { CliDependencies } from "../index.js";
export function registerCommandCommand(program: Command, dependencies: CliDependencies): void {
  program.command("command <commandId>").requiredOption("--worker-id <workerId>").action(async (commandId, options) => {
    if (!dependencies.runCommand) throw new Error("command runtime unavailable");
    await dependencies.runCommand(commandId, options.workerId);
  });
}
