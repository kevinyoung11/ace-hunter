#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { loadRedactionRegistry } from "../config/load-config.js";
import { log } from "../core/logger.js";

let commanderErrorOutput = "";

const program = new Command()
  .name("ace-hunter")
  .description("Discover and observe promising open-source products")
  .version("0.1.0")
  .configureOutput({
    writeErr: (value) => {
      commanderErrorOutput += value;
    },
  })
  .exitOverride();

program.parseAsync(process.argv).catch((error: unknown) => {
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
      : commanderErrorOutput.trim() ||
          (error instanceof Error ? error.message : String(error)),
    loadRedactionRegistry(process.env),
  );
  process.exitCode = 1;
});
