import type { Command } from "commander";
import type { CliDependencies } from "../index.js";
import { executeCommand } from "../output.js";

export function registerFollowCommands(program: Command, dependencies: CliDependencies): void {
  program
    .command("follow <target>")
    .description("Follow a product")
    .action(async (target: string) => {
      await executeCommand(dependencies.io, () => dependencies.follow(target));
    });

  program
    .command("unfollow <target>")
    .description("Stop following a product")
    .action(async (target: string) => {
      await executeCommand(dependencies.io, () => dependencies.unfollow(target));
    });
}
