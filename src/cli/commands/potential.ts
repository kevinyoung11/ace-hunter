import type { Command } from "commander";
import type { PotentialRule } from "../../reports/potential-list.js";
import type { CliDependencies } from "../index.js";
import { executeCommand } from "../output.js";
import { exactChoice, signalLimit } from "./signal-options.js";
import { outputFormat } from "./today.js";

const rules = ["all", "1d", "3d"] as const satisfies readonly PotentialRule[];

export function registerPotentialCommand(program: Command, dependencies: CliDependencies): void {
  program
    .command("potential")
    .description("Show repositories matching the current potential rules")
    .option("--rule <rule>", "all, 1d, or 3d", "all")
    .option("--limit <limit>", "1-1000 or all", "20")
    .option("--format <format>", "markdown or json", "markdown")
    .action(async (options: { rule: string; limit: string; format: string }) => {
      await executeCommand(
        dependencies.io,
        () => dependencies.potential({
          rule: exactChoice(options.rule, rules),
          limit: signalLimit(options.limit),
        }),
        () => outputFormat(options.format),
      );
    });
}
