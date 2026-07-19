import type { Command } from "commander";
import type { CliDependencies } from "../index.js";
import { executeCommand } from "../output.js";
import { outputFormat } from "./today.js";

export function registerAnalyzeCommand(program: Command, dependencies: CliDependencies): void {
  program
    .command("analyze <target>")
    .description("Analyze a product from stored facts")
    .option("--format <format>", "markdown or json", "markdown")
    .action(async (target: string, options: { format: string }) => {
      await executeCommand(
        dependencies.io,
        () => dependencies.analyze(target),
        outputFormat(options.format),
      );
    });
}
