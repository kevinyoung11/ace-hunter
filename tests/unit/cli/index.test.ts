import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("redacts secrets embedded in Commander parse errors", () => {
  const secret = "top-secret-value";
  const childEnv = { ...process.env };
  delete childEnv.ACE_HUNTER_GITHUB_TOKEN;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", `--token=${secret}`],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnv,
    },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("commander.unknownOption");
  expect(result.stderr).not.toContain(secret);
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
