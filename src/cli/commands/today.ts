import type { Command } from "commander";
import type { CliDependencies } from "../index.js";
import { executeCommand, type OutputFormat } from "../output.js";

export function registerTodayCommand(program: Command, dependencies: CliDependencies): void {
  program
    .command("today")
    .description("Show today's promising products")
    .option("--format <format>", "markdown or json", "markdown")
    .action(async (options: { format: string }) => {
      await executeCommand(
        dependencies.io,
        dependencies.today,
        outputFormat(options.format),
      );
    });
}

function outputFormat(value: string): OutputFormat {
  if (value !== "markdown" && value !== "json") throw invalidFormat();
  return value;
}

function invalidFormat(): Error {
  return Object.assign(new Error("invalid output format"), { code: "validation_error" });
}

export { outputFormat };
