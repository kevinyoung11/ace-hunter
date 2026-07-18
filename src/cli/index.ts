#!/usr/bin/env node
import { Command } from "commander";
import { loadRedactionRegistry } from "../config/load-config.js";
import { log } from "../core/logger.js";

const program = new Command()
  .name("ace-hunter")
  .description("Discover and observe promising open-source products")
  .version("0.1.0");

program.parseAsync(process.argv).catch((error: unknown) => {
  log(
    "error",
    error instanceof Error ? error.message : String(error),
    loadRedactionRegistry(process.env),
  );
  process.exitCode = 1;
});
