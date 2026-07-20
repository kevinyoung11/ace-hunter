import type { Command } from "commander";
import type { TrendingListPeriod } from "../../reports/trending-list.js";
import type { CliDependencies } from "../index.js";
import { executeCommand } from "../output.js";
import { exactChoice, signalLimit } from "./signal-options.js";
import { outputFormat } from "./today.js";

const periods = ["daily", "weekly", "monthly", "all"] as const satisfies readonly TrendingListPeriod[];

export function registerTrendingCommand(program: Command, dependencies: CliDependencies): void {
  program
    .command("trending <period>")
    .description("Show a verified GitHub Trending list")
    .option("--limit <limit>", "1-1000 or all", "20")
    .option("--format <format>", "markdown or json", "markdown")
    .action(async (periodValue: string, options: { limit: string; format: string }) => {
      const period = exactChoice(periodValue, periods);
      const limit = signalLimit(options.limit);
      const format = outputFormat(options.format);
      await executeCommand(
        dependencies.io,
        () => dependencies.trending({ period, limit }),
        format,
      );
    });
}
