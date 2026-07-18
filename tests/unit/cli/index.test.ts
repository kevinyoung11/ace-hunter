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
