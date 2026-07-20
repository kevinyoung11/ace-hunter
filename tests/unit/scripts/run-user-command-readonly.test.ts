import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("run-user-command read-only credential boundary", () => {
  it.each(["potential", "trending"])("retrieves only the runtime database for %s", (command) => {
    const result = invoke(command, command === "trending" ? ["daily"] : []);
    expect(result.accounts).toEqual(["runtime-database-url"]);
    expect(result.argv).toEqual([command, ...(command === "trending" ? ["daily"] : [])]);
  });

  it.each(["today", "trending-extra", "potentially", "--"])(
    "keeps the full credential path when the first token is %s",
    (command) => {
      expect(invoke(command).accounts).toEqual([
        "runtime-database-url",
        "github-token",
        "user-id",
        "deepseek-api-key",
      ]);
    },
  );
});

function invoke(command: string, args: string[] = []): { accounts: string[]; argv: string[] } {
  const root = mkdtempSync(join(tmpdir(), "ace-hunter-user-wrapper-"));
  directories.push(root);
  const release = join(root, "release");
  const home = join(root, "home");
  const appDirectory = join(home, "Library", "Application Support", "AceHunter");
  const log = join(root, "keychain.log");
  const output = join(root, "cli.json");
  mkdirSync(join(release, "scripts"), { recursive: true });
  mkdirSync(join(release, "dist", "scripts"), { recursive: true });
  mkdirSync(join(release, "dist", "src", "cli"), { recursive: true });
  mkdirSync(appDirectory, { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  cpSync(join(process.cwd(), "scripts", "run-user-command.sh"), join(release, "scripts", "run-user-command.sh"));
  writeFileSync(join(release, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(release, "dist", "scripts", "pipe-env-value.js"), [
    "const chunks=[];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    "process.stdout.write(`${process.argv[2]}=${Buffer.concat(chunks).toString().trim()}\\n`);",
  ].join("\n"));
  writeFileSync(join(release, "dist", "src", "cli", "index.js"), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.ACE_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));",
  ].join("\n"));
  const helper = join(root, "keychain-helper.sh");
  writeFileSync(helper, [
    "#!/bin/bash",
    "set -euo pipefail",
    'printf "%s\\n" "$2" >>"$ACE_TEST_KEYCHAIN_LOG"',
    'printf "value-for-%s\\n" "$2"',
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(appDirectory, "scheduler.conf"), [
    `KEYCHAIN_HELPER='${helper}'`,
    `NODE_PATH='${process.execPath}'`,
    "TWITTER_CLI_PATH='twitter'",
  ].join("\n"));

  execFileSync("bash", [join(release, "scripts", "run-user-command.sh"), command, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: join(root, "tmp"),
      ACE_TEST_KEYCHAIN_LOG: log,
      ACE_TEST_OUTPUT: output,
    },
  });
  return {
    accounts: readFileSync(log, "utf8").trim().split("\n"),
    argv: JSON.parse(readFileSync(output, "utf8")) as string[],
  };
}
