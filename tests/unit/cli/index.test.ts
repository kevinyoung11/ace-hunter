import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([
  ["root unknown option", [`--token=top-secret-value`]],
  ["potential unknown option", ["potential", `--token=top-secret-value`]],
  ["trending unknown option", ["trending", "daily", `--token=top-secret-value`]],
  ["missing trending period", ["trending"]],
  ["missing potential limit value", ["potential", "--limit"]],
])("maps %s to one safe process error without rendering Commander input", (_name, args) => {
  const secret = "top-secret-value";
  const childEnv = { ...process.env };
  delete childEnv.ACE_HUNTER_GITHUB_TOKEN;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnv,
    },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("validation_error\n");
  expect(result.stderr).not.toContain(secret);
  expect(result.stderr).not.toContain("unknown option");
  expect(result.stderr).not.toContain("missing mandatory argument");
  expect(result.stderr).not.toContain("option '--limit <limit>' argument missing");
});

it.each([
  ["potential limit", ["potential", "--limit", "0"], "invalid signal option"],
  ["trending period", ["trending", "yearly"], "invalid signal option"],
  ["signal format", ["trending", "daily", "--format", "yaml"], "invalid output format"],
])("returns the safe validation code from the real process for %s", (_name, args, detail) => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", ...args],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env } },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("validation_error\n");
  expect(result.stderr).not.toContain(detail);
  expect(result.stderr).not.toContain("CLI command failed");
});
