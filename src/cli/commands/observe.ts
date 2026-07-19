import type { Command } from "commander";
import type { CliDependencies } from "../index.js";
import { executeCommand } from "../output.js";
import { outputFormat } from "./today.js";

export function registerObserveCommand(program: Command, dependencies: CliDependencies): void {
  program
    .command("observe <target>")
    .description("Refresh and observe a product")
    .option("--format <format>", "markdown or json", "markdown")
    .action(async (target: string, options: { format: string }) => {
      await executeCommand(
        dependencies.io,
        () => dependencies.observe(target),
        outputFormat(options.format),
      );
    });
}
